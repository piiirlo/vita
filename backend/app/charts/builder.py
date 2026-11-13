"""Build the SQL for a chart query on top of a dataset (sqlglot ASTs only, no string SQL).

    SELECT <time bucket>, <dimensions>, <series>, <metrics>
    FROM <dataset>                                  -- Part 5 from_clause
    [JOIN (<top N series>) AS "top_series" ON <series> <=> "top_series"."__series"]
    WHERE <time range> AND <filters>
    GROUP BY <the same expressions>
    ORDER BY ...
    LIMIT <row_limit + 1>                           -- + 1 so `truncated` is exact

Everything is validated against the dataset first; problems raise QueryError("invalid").
GROUP BY repeats the expressions instead of using aliases: on Postgres, GROUP BY "order_date"
would mean the raw column, not the time bucket aliased "order_date". ORDER BY uses the
output names (both databases resolve those to the SELECT list first).
"""

from dataclasses import dataclass
from datetime import date
from typing import NoReturn

from sqlglot import exp

from app.charts.filters import NUMERIC_OR_TEMPORAL, date_literal, filter_condition
from app.charts.timegrain import TIME_PARTS, time_bucket, time_part
from app.charts.timerange import aligned_bounds
from app.datasets.checks import parse_metric_expression
from app.datasets.sql import column as sql_column
from app.datasets.sql import dialect_for, from_clause, quoted, source_of
from app.datasets.timecols import allowed_grains, time_value
from app.models import Dataset, DatasetColumn
from app.query import QueryError
from app.schemas.charts import (
    DEFAULT_BINS,
    GRAINS,
    MAX_PIVOT_COLUMN_DIMENSIONS,
    MAX_PIVOT_ROW_DIMENSIONS,
    AdhocMetric,
    AxisGrain,
    ChartQuery,
    MetricRef,
    SqlMetric,
    VizType,
)

TOP_SERIES_ALIAS = "top_series"
TOP_SERIES_COLUMN = "__series"
# Pie: 1 on the row that groups every slice outside the top N ("Other"), else 0.
OTHER_COLUMN = "__other"
TOP_FLAG_COLUMN = "__is_top"
# Pivot: how many row / column dimensions an output row is grouped by (fewer = a subtotal).
ROW_LEVEL_COLUMN = "__row_level"
COL_LEVEL_COLUMN = "__col_level"
# Histogram output: bin number (NULL = rows without a value) and its [start, end) range.
BIN_COLUMN = "__bin"
BIN_START_COLUMN = "__bin_start"
BIN_END_COLUMN = "__bin_end"
# A dimension "column@part" groups by a date bucket (day ... year) or a time part.
PART_SEPARATOR = "@"


@dataclass(frozen=True)
class Dim:
    """A grouping dimension: its output name (as asked), SQL expression and column."""

    name: str
    expr: exp.Expr
    column: DatasetColumn


# Ungrouped totals over a time range get MIN(time column) as a last, hidden column: NULL means
# no row fell in the range ("no data"), which a total of 0 or NULL can't tell apart.
ROWS_PROBE_COLUMN = "__first_time"

# Which column types each ad-hoc aggregate accepts.
_AGGREGATE_TYPES: dict[str, set[str] | None] = {
    "SUM": {"number"},
    "AVG": {"number"},
    "MIN": NUMERIC_OR_TEMPORAL | {"string"},
    "MAX": NUMERIC_OR_TEMPORAL | {"string"},
    "COUNT": None,  # any type
    "COUNT_DISTINCT": None,
}


@dataclass(frozen=True)
class BuiltChartQuery:
    sql: str
    row_limit: int
    # The time range the query filtered on: [start, end), None = open on that side.
    time_start: date | None = None
    time_end: date | None = None
    # True when the last column is ROWS_PROBE_COLUMN (see above); the API strips it.
    rows_probe: bool = False


def _invalid(message: str) -> NoReturn:
    raise QueryError("invalid", message)


def build_chart_query(
    dataset: Dataset,
    db_type: str,
    viz_type: VizType,
    query: ChartQuery,
    today: date | None = None,
) -> BuiltChartQuery:
    """Validate `query` against the dataset and return the SQL. Raises QueryError."""
    return _Builder(dataset, db_type, today or date.today()).build(viz_type, query)


class _Builder:
    def __init__(self, dataset: Dataset, db_type: str, today: date) -> None:
        self.dataset = dataset
        self.db_type = db_type
        self.dialect = dialect_for(db_type)
        self.today = today
        self.columns = {c.name: c for c in dataset.columns}
        self.metrics = {m.name: m for m in dataset.metrics}
        self.selects: list[exp.Expr] = []
        self.group_by: list[exp.Expr] = []
        self.outputs: dict[str, exp.Expr] = {}  # output name -> expression
        self.time_bounds: tuple[date | None, date | None] = (None, None)

    # ---------- lookups ----------

    def column(self, name: str, role: str) -> DatasetColumn:
        col = self.columns.get(name)
        if col is None:
            _invalid(f'Unknown column "{name}" ({role}). It isn\'t part of this dataset.')
        if col.is_missing:
            _invalid(
                f'Column "{name}" ({role}) no longer exists in the database. '
                "Sync the dataset or remove it from the chart."
            )
        if col.is_hidden:
            _invalid(f'Column "{name}" ({role}) is hidden in the dataset.')
        return col

    def group_column(self, name: str, role: str) -> DatasetColumn:
        col = self.column(name, role)
        if not (col.is_dimension or col.is_temporal):
            _invalid(
                f'"{name}" can\'t be used to group by. Mark it as a dimension in the dataset first.'
            )
        return col

    def dim(self, ref: str, role: str) -> Dim:
        """A dimension: a column (dimension or temporal), or "column@part" where part is a
        grain (day, week, month, quarter, year: the bucket's first day) or a time part
        (day_of_week 1 = Monday, hour_of_day, month_of_year)."""
        if ref in self.columns or PART_SEPARATOR not in ref:
            col = self.group_column(ref, role)
            return Dim(ref, sql_column(col.name), col)
        name, part = ref.rsplit(PART_SEPARATOR, 1)
        col = self.column(name, role)
        if not col.is_temporal:
            _invalid(f'"{name}" is not a time column, so it has no "{part}".')
        if part in GRAINS:
            self.check_grain(col, part)
            value = time_value(col, self.db_type)
            return Dim(ref, time_bucket(value, part, self.db_type), col)  # type: ignore[arg-type]
        if part in TIME_PARTS:
            if col.time_kind == "year_number":
                _invalid(f'"{name}" only has years, so it has no "{part}".')
            if part == "hour_of_day" and (
                col.effective_type == "date" or col.time_kind is not None
            ):
                _invalid(f'"{name}" is a date without a time, so it has no hour.')
            return Dim(ref, time_part(time_value(col, self.db_type), part, self.db_type), col)
        _invalid(f'Unknown time part "{part}" ({role}).')

    def check_grain(self, col: DatasetColumn, grain: str) -> None:
        allowed = allowed_grains(col)
        if allowed is not None and grain not in allowed:
            _invalid(
                f'"{col.name}" only has years (it is a year number), so it can\'t be grouped '
                f"by {grain}. Use the Year grain."
            )

    def time_axis(self, col: DatasetColumn, grain: AxisGrain) -> exp.Expr:
        """The x axis of a time chart: the grain's bucket, or every time value ("raw")."""
        value = time_value(col, self.db_type)
        if grain == "raw":
            return value
        return time_bucket(value, grain, self.db_type)

    def metric(self, ref: MetricRef) -> tuple[str, exp.Expr]:
        if isinstance(ref, str):
            saved = self.metrics.get(ref)
            if saved is None:
                _invalid(f"Unknown metric \"{ref}\". It isn't one of this dataset's metrics.")
            return saved.name, parse_metric_expression(saved.expression, self.db_type)
        if isinstance(ref, SqlMetric):
            # Custom SQL: the same checks as a saved metric's expression.
            return ref.name, parse_metric_expression(ref.sql, self.db_type)
        return ref.name, self.adhoc_metric(ref)

    def adhoc_metric(self, ref: AdhocMetric) -> exp.Expr:
        col = self.column(ref.column, "metric")
        allowed = _AGGREGATE_TYPES[ref.aggregate]
        if allowed is not None and col.effective_type not in allowed:
            _invalid(
                f'{ref.aggregate} doesn\'t work on "{col.name}" ({col.effective_type} column).'
            )
        target = sql_column(col.name)
        match ref.aggregate:
            case "SUM":
                return exp.Sum(this=target)
            case "AVG":
                return exp.Avg(this=target)
            case "MIN":
                return exp.Min(this=target)
            case "MAX":
                return exp.Max(this=target)
            case "COUNT":
                return exp.Count(this=target)
            case "COUNT_DISTINCT":
                return exp.Count(this=exp.Distinct(expressions=[target]))

    # ---------- building ----------

    def add_output(self, name: str, expression: exp.Expr, group: bool) -> None:
        if name in self.outputs:
            _invalid(f'"{name}" appears twice in the chart. Give ad-hoc metrics a different label.')
        self.outputs[name] = expression
        plain = isinstance(expression, exp.Column) and expression.name == name
        self.selects.append(expression.copy() if plain else expression.as_(name, quoted=True))
        if group:
            self.group_by.append(expression.copy())

    def build(self, viz_type: VizType, query: ChartQuery) -> BuiltChartQuery:
        raw = bool(query.columns)
        _check_shape(viz_type, query, raw)
        if viz_type in ("pie", "treemap"):
            return self.build_top_n(query)
        if viz_type == "pivot_table":
            return self.build_pivot(query)
        if viz_type == "histogram":
            return self.build_histogram(query)

        time_col, grain = self.time_column(query, raw)
        conditions = self.conditions(query, time_col)

        metric_exprs: list[exp.Expr] = []
        series_dim: Dim | None = None
        if raw:
            for name in query.columns:
                self.add_output(name, sql_column(self.column(name, "columns").name), group=False)
        else:
            if time_col is not None and grain is not None:
                if time_col.name in query.dimensions or time_col.name == query.series:
                    _invalid(
                        f'"{time_col.name}" is already the time axis; don\'t also group by it.'
                    )
                self.add_output(time_col.name, self.time_axis(time_col, grain), group=True)
            for name in query.dimensions:
                self.add_output(name, self.dim(name, "dimension").expr, group=True)
            if query.series is not None:
                if query.series in query.dimensions:
                    _invalid(f'"{query.series}" is both a dimension and the series.')
                series_dim = self.dim(query.series, "series")
                self.add_output(query.series, series_dim.expr, group=True)
            for ref in query.metrics:
                name, expression = self.metric(ref)
                metric_exprs.append(expression)
                self.add_output(name, expression, group=False)

        # One total row over a time range: also ask whether any row was in the range.
        rows_probe = (
            not raw
            and not self.group_by
            and time_col is not None
            and any(bound is not None for bound in self.time_bounds)
        )
        if rows_probe and time_col is not None:
            self.add_output(
                ROWS_PROBE_COLUMN, exp.Min(this=time_value(time_col, self.db_type)), group=False
            )

        select = exp.select(*self.selects).from_(from_clause(source_of(self.dataset), self.db_type))
        # Scatter colors points by the series: every point stays (no top-N join).
        if (
            series_dim is not None
            and query.series_limit is not None
            and metric_exprs
            and viz_type != "scatter"
        ):
            select = self.join_top_series(
                select, series_dim.expr, metric_exprs[0], conditions, query.series_limit
            )
        if conditions:
            select = select.where(exp.and_(*[c.copy() for c in conditions]))
        if self.group_by:
            select = select.group_by(*self.group_by)
        # Line / area with a dimension on the x axis: ordered categories, ascending.
        order = self.order(
            query,
            time_col if grain else None,
            raw,
            by_dimensions=viz_type in ("heatmap", "line", "area"),
        )
        if order:
            select = select.order_by(*order)
        select = select.limit(query.row_limit + 1)
        return BuiltChartQuery(
            select.sql(dialect=self.dialect, pretty=True),
            query.row_limit,
            time_start=self.time_bounds[0],
            time_end=self.time_bounds[1],
            rows_probe=rows_probe,
        )

    def build_top_n(self, query: ChartQuery) -> BuiltChartQuery:
        """Pie (one dimension) and treemap (one or two levels), one metric. With
        series_limit N: the top N outer values by the metric, and one more row
        (__other = 1, dimensions NULL) for everything else, computed in SQL so "Other" is
        right for any aggregate (AVG, COUNT DISTINCT...), not just sums. A second level is
        grouped inside each top value (nothing inside "Other")."""
        time_col, _ = self.time_column(query, raw=False)
        conditions = self.conditions(query, time_col)
        dims = [self.dim(name, "dimension") for name in query.dimensions]
        if len(dims) == 2 and dims[0].name == dims[1].name:
            _invalid("Pick two different dimensions for the treemap's levels.")
        refs = [d.expr for d in dims]
        name, metric_expr = self.metric(query.metrics[0])
        self.outputs = {d.name: r for d, r in zip(dims, refs, strict=True)}
        self.outputs[OTHER_COLUMN] = refs[0]
        if name in self.outputs:
            _invalid(f'"{name}" appears twice in the chart. Give ad-hoc metrics a different label.')
        source = from_clause(source_of(self.dataset), self.db_type)
        limit = query.series_limit

        labels: list[exp.Expr]
        if limit is None:
            labels = [r.copy() for r in refs]
            flag: exp.Expr = exp.Literal.number(0)
            select = exp.select(
                *[label.as_(d.name, quoted=True) for label, d in zip(labels, dims, strict=True)],
                flag.as_(OTHER_COLUMN, quoted=True),
                metric_expr.as_(name, quoted=True),
            ).from_(source)
            group_by: list[exp.Expr] = [r.copy() for r in refs]
        else:
            outer = refs[0]
            top = (
                exp.select(
                    outer.as_(TOP_SERIES_COLUMN, quoted=True),
                    exp.Literal.number(1).as_(TOP_FLAG_COLUMN, quoted=True),
                )
                .from_(from_clause(source_of(self.dataset), self.db_type))
                .group_by(outer.copy())
                .order_by(_ordered(metric_expr, desc=True), _ordered(outer, desc=False))
                .limit(limit)
            )
            if conditions:
                top = top.where(exp.and_(*[c.copy() for c in conditions]))
            in_top = exp.EQ(
                this=exp.Column(this=quoted(TOP_FLAG_COLUMN), table=quoted(TOP_SERIES_ALIAS)),
                expression=exp.Literal.number(1),
            )
            labels = [exp.Case(ifs=[exp.If(this=in_top.copy(), true=r.copy())]) for r in refs]
            flag = exp.Case(
                ifs=[exp.If(this=in_top.copy(), true=exp.Literal.number(0))],
                default=exp.Literal.number(1),
            )
            on = exp.NullSafeEQ(
                this=outer.copy(),
                expression=exp.Column(
                    this=quoted(TOP_SERIES_COLUMN), table=quoted(TOP_SERIES_ALIAS)
                ),
            )
            joined = exp.Subquery(this=top, alias=exp.TableAlias(this=quoted(TOP_SERIES_ALIAS)))
            select = (
                exp.select(
                    *[
                        label.as_(d.name, quoted=True)
                        for label, d in zip(labels, dims, strict=True)
                    ],
                    flag.as_(OTHER_COLUMN, quoted=True),
                    metric_expr.as_(name, quoted=True),
                )
                .from_(source)
                .join(joined, on=on, join_type="left")
            )
            group_by = [*[label.copy() for label in labels], flag.copy()]

        if conditions:
            select = select.where(exp.and_(*[c.copy() for c in conditions]))
        select = select.group_by(*group_by).order_by(
            _ordered(exp.Column(this=quoted(OTHER_COLUMN)), desc=False),
            _ordered(exp.Column(this=quoted(name)), desc=True),
        )
        select = select.limit(query.row_limit + 1)
        return BuiltChartQuery(
            select.sql(dialect=self.dialect, pretty=True),
            query.row_limit,
            time_start=self.time_bounds[0],
            time_end=self.time_bounds[1],
        )

    def build_pivot(self, query: ChartQuery) -> BuiltChartQuery:
        """Rows x columns x metrics, grouped in SQL; the browser only lays it out.

        Every output row says which level it is: __row_level = how many row dimensions are
        grouped (the rest are NULL: a subtotal), __col_level the same for columns. So a real
        NULL value is never mistaken for a total. With `totals`, every (row prefix x column
        prefix) level is computed in SQL, so AVG / COUNT DISTINCT totals are right:
        Postgres: GROUPING SETS (one scan of the data); MySQL has no GROUPING SETS: one
        UNION ALL branch per level."""
        time_col, _ = self.time_column(query, raw=False)
        conditions = self.conditions(query, time_col)
        rows = [self.dim(n, "row dimension") for n in query.dimensions]
        cols = [self.dim(n, "column dimension") for n in query.column_dimensions]
        metrics = [self.metric(ref) for ref in query.metrics]
        for d in [*rows, *cols]:
            self.outputs[d.name] = d.expr
        for level_name in (ROW_LEVEL_COLUMN, COL_LEVEL_COLUMN):
            self.outputs[level_name] = exp.Null()
        for name, expression in metrics:
            if name in self.outputs:
                _invalid(
                    f'"{name}" appears twice in the chart. Give ad-hoc metrics a different label.'
                )
            self.outputs[name] = expression

        levels = (
            [(i, j) for i in range(len(rows) + 1) for j in range(len(cols) + 1)]
            if query.totals
            else [(len(rows), len(cols))]
        )
        source = from_clause(source_of(self.dataset), self.db_type)
        where = exp.and_(*[c.copy() for c in conditions]) if conditions else None
        dims = [*rows, *cols]

        def metric_selects() -> list[exp.Expr]:
            return [e.copy().as_(name, quoted=True) for name, e in metrics]

        def grouped_count(prefix: list[Dim]) -> exp.Expr:
            # How many of these are grouped: 1 - GROUPING(d) is 1 when d is grouped. They
            # are a prefix, so the count says exactly which ones.
            if not prefix:
                return exp.Literal.number(0)
            terms: list[exp.Expr] = [
                exp.Sub(
                    this=exp.Literal.number(1),
                    expression=exp.Anonymous(this="GROUPING", expressions=[d.expr.copy()]),
                )
                for d in prefix
            ]
            total = terms[0]
            for term in terms[1:]:
                total = exp.Add(this=total, expression=term)
            return exp.Paren(this=total)

        statement: exp.Query
        if len(levels) == 1 or self.db_type != "mysql":
            many = len(levels) > 1
            select = exp.select(
                *[d.expr.copy().as_(d.name, quoted=True) for d in dims],
                (grouped_count(rows) if many else exp.Literal.number(len(rows))).as_(
                    ROW_LEVEL_COLUMN, quoted=True
                ),
                (grouped_count(cols) if many else exp.Literal.number(len(cols))).as_(
                    COL_LEVEL_COLUMN, quoted=True
                ),
                *metric_selects(),
            ).from_(source)
            if where is not None:
                select = select.where(where)
            if many:
                sets = [
                    exp.Tuple(expressions=[d.expr.copy() for d in [*rows[:i], *cols[:j]]])
                    for i, j in levels
                ]
                select.set("group", exp.Group(expressions=[exp.GroupingSets(expressions=sets)]))
            elif dims:
                select = select.group_by(*[d.expr.copy() for d in dims])
            statement = select
        else:
            branches: list[exp.Select] = []
            for i, j in levels:
                grouped = [*rows[:i], *cols[:j]]
                names = {d.name for d in grouped}
                branch = exp.select(
                    *[
                        (d.expr.copy() if d.name in names else exp.Null()).as_(d.name, quoted=True)
                        for d in dims
                    ],
                    exp.Literal.number(i).as_(ROW_LEVEL_COLUMN, quoted=True),
                    exp.Literal.number(j).as_(COL_LEVEL_COLUMN, quoted=True),
                    *metric_selects(),
                ).from_(source.copy())
                if where is not None:
                    branch = branch.where(where.copy())
                if grouped:
                    branch = branch.group_by(*[d.expr.copy() for d in grouped])
                branches.append(branch)
            union: exp.Query = branches[0]
            for branch in branches[1:]:
                union = exp.union(union, branch, distinct=False)
            statement = union

        # Details first within a group, then its subtotal (lower level), then the next group.
        order = [
            *[_ordered(exp.Column(this=quoted(d.name)), desc=False) for d in dims],
            _ordered(exp.Column(this=quoted(ROW_LEVEL_COLUMN)), desc=True),
            _ordered(exp.Column(this=quoted(COL_LEVEL_COLUMN)), desc=True),
        ]
        statement = statement.order_by(*order).limit(query.row_limit + 1)
        return BuiltChartQuery(
            statement.sql(dialect=self.dialect, pretty=True),
            query.row_limit,
            time_start=self.time_bounds[0],
            time_end=self.time_bounds[1],
        )

    def build_histogram(self, query: ChartQuery) -> BuiltChartQuery:
        """One numeric column cut into bins, one metric per bin (usually the row count).

        Bins of a fixed width are aligned to multiples of it (FLOOR(x / width)), so negative
        values work. A number of bins splits [MIN, MAX] of the filtered rows evenly (MAX goes
        in the last bin; one value only: a single bin). Rows without a value get bin NULL.
        Plain arithmetic on both databases; the bin range is computed outside the grouping."""
        assert query.bins is not None
        time_col, _ = self.time_column(query, raw=False)
        conditions = self.conditions(query, time_col)
        col = self.column(query.bins.column, "histogram column")
        if col.effective_type != "number":
            _invalid(f"\"{col.name}\" isn't a number column, so it can't be binned.")
        name, metric_expr = self.metric(query.metrics[0])
        if name in (BIN_COLUMN, BIN_START_COLUMN, BIN_END_COLUMN):
            _invalid(f'"{name}" is a reserved name; give the metric another label.')
        x = sql_column(col.name)
        source = from_clause(source_of(self.dataset), self.db_type)
        inner_alias = "__binned"
        num = exp.Literal.number

        def binned(field: str) -> exp.Column:
            return exp.Column(this=quoted(field), table=quoted(inner_alias))

        if query.bins.width is not None:
            width = num(query.bins.width)
            bin_expr: exp.Expr = exp.Floor(this=exp.Div(this=x.copy(), expression=width.copy()))
            inner = exp.select(
                bin_expr.as_(BIN_COLUMN, quoted=True), metric_expr.as_(name, quoted=True)
            ).from_(source)
            group: list[exp.Expr] = [bin_expr.copy()]
            start: exp.Expr = exp.Mul(this=binned(BIN_COLUMN), expression=width.copy())
            end: exp.Expr = exp.Mul(
                this=exp.Paren(this=exp.Add(this=binned(BIN_COLUMN), expression=num(1))),
                expression=width.copy(),
            )
        else:
            count = query.bins.count or DEFAULT_BINS
            bounds_alias = "__bounds"
            lo = exp.Column(this=quoted("__lo"), table=quoted(bounds_alias))
            hi = exp.Column(this=quoted("__hi"), table=quoted(bounds_alias))
            bounds = exp.select(
                exp.Min(this=x.copy()).as_("__lo", quoted=True),
                exp.Max(this=x.copy()).as_("__hi", quoted=True),
            ).from_(from_clause(source_of(self.dataset), self.db_type))
            if conditions:
                bounds = bounds.where(exp.and_(*[c.copy() for c in conditions]))
            span = exp.Paren(this=exp.Sub(this=hi.copy(), expression=lo.copy()))
            as_float = exp.cast(x.copy(), exp.DataType.build("DOUBLE"))
            scaled = exp.Floor(
                this=exp.Mul(
                    this=exp.Div(
                        # As a float: MySQL rounds DECIMAL division, which could move a value
                        # just under a bin edge into the next bin.
                        this=exp.Paren(this=exp.Sub(this=as_float, expression=lo.copy())),
                        expression=span.copy(),
                    ),
                    expression=num(count),
                )
            )
            bin_expr = exp.Case(
                ifs=[
                    exp.If(this=exp.Is(this=x.copy(), expression=exp.Null()), true=exp.Null()),
                    exp.If(this=exp.EQ(this=hi.copy(), expression=lo.copy()), true=num(0)),
                ],
                default=exp.Least(this=scaled, expressions=[num(count - 1)]),
            )
            inner = (
                exp.select(
                    bin_expr.as_(BIN_COLUMN, quoted=True),
                    lo.copy().as_("__lo", quoted=True),
                    hi.copy().as_("__hi", quoted=True),
                    metric_expr.as_(name, quoted=True),
                )
                .from_(source)
                .join(
                    exp.Subquery(this=bounds, alias=exp.TableAlias(this=quoted(bounds_alias))),
                    join_type="cross",
                )
            )
            group = [bin_expr.copy(), lo.copy(), hi.copy()]
            step = exp.Div(
                this=exp.Paren(this=exp.Sub(this=binned("__hi"), expression=binned("__lo"))),
                expression=num(count),
            )
            start = exp.Add(
                this=binned("__lo"), expression=exp.Mul(this=binned(BIN_COLUMN), expression=step)
            )
            end = exp.Add(
                this=binned("__lo"),
                expression=exp.Mul(
                    this=exp.Paren(this=exp.Add(this=binned(BIN_COLUMN), expression=num(1))),
                    expression=step.copy(),
                ),
            )
        if conditions:
            inner = inner.where(exp.and_(*[c.copy() for c in conditions]))
        inner = inner.group_by(*group)
        select = (
            exp.select(
                binned(BIN_COLUMN).as_(BIN_COLUMN, quoted=True),
                start.as_(BIN_START_COLUMN, quoted=True),
                end.as_(BIN_END_COLUMN, quoted=True),
                binned(name).as_(name, quoted=True),
            )
            .from_(exp.Subquery(this=inner, alias=exp.TableAlias(this=quoted(inner_alias))))
            .order_by(_ordered(exp.Column(this=quoted(BIN_COLUMN)), desc=False))
            .limit(query.row_limit + 1)
        )
        return BuiltChartQuery(
            select.sql(dialect=self.dialect, pretty=True),
            query.row_limit,
            time_start=self.time_bounds[0],
            time_end=self.time_bounds[1],
        )

    def time_column(
        self, query: ChartQuery, raw: bool
    ) -> tuple[DatasetColumn | None, AxisGrain | None]:
        time = query.time
        if time is None or (time.grain is None and time.range.kind == "none"):
            return None, None
        if raw and time.grain is not None:
            _invalid("Raw records can't use a time grain; use a time range only.")
        name = time.column or self.dataset.main_time_column
        if not name:
            _invalid("Pick a time column: this dataset has no main time column.")
        col = self.column(name, "time column")
        if not col.is_temporal:
            _invalid(f'"{name}" is not a time column. Mark it as temporal in the dataset first.')
        time_value(col, self.db_type)  # a column that couldn't be checked yet: a clear error
        if time.grain is not None:
            self.check_grain(col, time.grain)
        return col, time.grain

    def conditions(self, query: ChartQuery, time_col: DatasetColumn | None) -> list[exp.Expr]:
        conditions: list[exp.Expr] = []
        if time_col is not None and query.time is not None:
            grain = query.time.grain
            start, end = aligned_bounds(
                query.time.range, self.today, None if grain == "raw" else grain
            )
            self.time_bounds = (start, end)
            ref = time_value(time_col, self.db_type)
            if start is not None:
                conditions.append(exp.GTE(this=ref.copy(), expression=date_literal(start)))
            if end is not None:
                conditions.append(exp.LT(this=ref.copy(), expression=date_literal(end)))
        for f in query.filters:
            col = self.column(f.column, "filter")
            conditions.append(filter_condition(f, col, sql_column(col.name)))
        return conditions

    def join_top_series(
        self,
        select: exp.Select,
        series: exp.Expr,
        first_metric: exp.Expr,
        conditions: list[exp.Expr],
        limit: int,
    ) -> exp.Select:
        """Keep only the top `limit` series by the first metric, computed in SQL. A JOIN, not
        IN (...): MySQL doesn't allow LIMIT inside an IN subquery. <=> keeps a NULL series."""
        ref = series
        top = (
            exp.select(ref.as_(TOP_SERIES_COLUMN, quoted=True))
            .from_(from_clause(source_of(self.dataset), self.db_type))
            .group_by(ref.copy())
            .order_by(_ordered(first_metric, desc=True), _ordered(ref, desc=False))
            .limit(limit)
        )
        if conditions:
            top = top.where(exp.and_(*[c.copy() for c in conditions]))
        on = exp.NullSafeEQ(
            this=ref.copy(),
            expression=exp.Column(this=quoted(TOP_SERIES_COLUMN), table=quoted(TOP_SERIES_ALIAS)),
        )
        joined = exp.Subquery(this=top, alias=exp.TableAlias(this=quoted(TOP_SERIES_ALIAS)))
        return select.join(joined, on=on)

    def order(
        self,
        query: ChartQuery,
        time_col: DatasetColumn | None,
        raw: bool,
        by_dimensions: bool = False,
    ) -> list[exp.Ordered]:
        def by(name: str, desc: bool) -> exp.Ordered:
            return _ordered(exp.Column(this=quoted(name)), desc)

        if query.order_by is not None:
            name = query.order_by.by
            if name not in self.outputs:
                _invalid(f"Can't order by \"{name}\": it isn't a metric or column of this chart.")
            return [by(name, query.order_by.descending)]
        if raw:
            return []
        if by_dimensions and query.dimensions:
            order = [by(name, False) for name in query.dimensions]
            if query.series is not None:
                order.append(by(query.series, False))
            return order
        if time_col is not None:
            order = [by(time_col.name, False)]
            if query.series is not None:
                order.append(by(query.series, False))
            return order
        if query.metrics:
            return [by(self.metric_names(query)[0], True)]
        return [by(name, False) for name in self.outputs]

    def metric_names(self, query: ChartQuery) -> list[str]:
        return [ref if isinstance(ref, str) else ref.name for ref in query.metrics]


def _ordered(expression: exp.Expr, desc: bool) -> exp.Ordered:
    """ORDER BY item where NULL sorts as the smallest value on both databases (MySQL's
    native order; Postgres gets NULLS FIRST / NULLS LAST). Leaving it implicit makes sqlglot
    emulate a different NULL order on MySQL with CASE expressions."""
    return exp.Ordered(this=expression.copy(), desc=desc, nulls_first=not desc)


def _check_shape(viz_type: VizType, query: ChartQuery, raw: bool) -> None:
    """What each chart type needs. Column-level checks happen while building."""
    grain = query.time.grain if query.time else None
    if raw:
        if viz_type != "table":
            _invalid("Raw records (a list of columns) only work in a table chart.")
        if query.metrics or query.dimensions or query.series:
            _invalid("Raw records can't have metrics, dimensions or a series.")
        return
    if query.series is not None and viz_type not in ("bar", "line", "area", "scatter"):
        _invalid("Only bar and line charts (and area charts) have a series.")
    if query.bins is not None and viz_type != "histogram":
        _invalid("Only histograms have bins.")
    if query.column_dimensions and viz_type != "pivot_table":
        _invalid("Only pivot tables have column dimensions.")
    if viz_type == "table":
        if not (query.metrics or query.dimensions or grain):
            _invalid("Pick at least one metric or dimension (or columns for raw records).")
    elif not query.metrics:
        _invalid("Pick at least one metric.")
    if viz_type in ("big_number", "gauge"):
        name = "big number" if viz_type == "big_number" else "gauge"
        if len(query.metrics) != 1:
            _invalid(f"A {name} shows exactly one metric.")
        if query.dimensions:
            _invalid(f"A {name} can't have dimensions.")
        if viz_type == "gauge" and grain is not None:
            _invalid("A gauge has no time grain; use a time range to filter.")
    elif viz_type in ("bar", "combo", "line", "area"):
        name = {"bar": "bar chart", "combo": "combo chart", "line": "line chart"}.get(
            viz_type, "area chart"
        )
        if len(query.dimensions) > 1 or (grain and query.dimensions):
            _invalid(f"A {name}'s x axis is either one dimension or a time grain, not both.")
        if not (grain or query.dimensions):
            _invalid(f"Pick the {name}'s x axis: a dimension or a time grain.")
    elif viz_type in ("pie", "funnel"):
        name, what = ("pie chart", "the slices") if viz_type == "pie" else ("funnel", "the steps")
        if len(query.metrics) != 1:
            _invalid(f"A {name} shows exactly one metric.")
        if len(query.dimensions) != 1:
            _invalid(f"A {name} needs exactly one dimension ({what}).")
        if grain is not None:
            _invalid(f"A {name} has no time grain; use a time range to filter.")
    elif viz_type == "treemap":
        if len(query.metrics) != 1:
            _invalid("A treemap shows exactly one metric.")
        if not 1 <= len(query.dimensions) <= 2:
            _invalid("A treemap needs one or two dimensions (the levels).")
        if grain is not None:
            _invalid("A treemap has no time grain; use a time range to filter.")
    elif viz_type == "heatmap":
        if len(query.metrics) != 1:
            _invalid("A heatmap shows exactly one metric.")
        if len(query.dimensions) != 2:
            _invalid("A heatmap needs two dimensions (its rows and columns).")
        if query.dimensions[0] == query.dimensions[1]:
            _invalid("Pick two different dimensions for the heatmap.")
        if grain is not None:
            _invalid("A heatmap has no time grain: use a date bucket (e.g. by month) instead.")
    elif viz_type == "scatter":
        if not 2 <= len(query.metrics) <= 3:
            _invalid("A scatter plot needs an x and a y metric (and maybe a size metric).")
        if len(query.dimensions) != 1:
            _invalid("A scatter plot needs one dimension: one point per value.")
        if grain is not None:
            _invalid("A scatter plot has no time grain; use a time range to filter.")
    elif viz_type == "histogram":
        if query.bins is None:
            _invalid("A histogram needs a number column to bin.")
        if len(query.metrics) != 1:
            _invalid("A histogram shows exactly one metric per bin (usually the count).")
        if query.dimensions or grain is not None:
            _invalid("A histogram has no dimensions or time grain; use filters instead.")
    elif viz_type == "world_map":
        if len(query.metrics) != 1:
            _invalid("A world map shows exactly one metric.")
        if len(query.dimensions) != 1:
            _invalid("A world map needs one dimension: the countries.")
        if grain is not None:
            _invalid("A world map has no time grain; use a time range to filter.")
    elif viz_type == "pivot_table":
        if len(query.dimensions) > MAX_PIVOT_ROW_DIMENSIONS:
            _invalid(f"A pivot table has at most {MAX_PIVOT_ROW_DIMENSIONS} row dimensions.")
        if len(query.column_dimensions) > MAX_PIVOT_COLUMN_DIMENSIONS:
            _invalid(f"A pivot table has at most {MAX_PIVOT_COLUMN_DIMENSIONS} column dimensions.")
        if not (query.dimensions or query.column_dimensions):
            _invalid("Pick at least one row or column dimension.")
        both = set(query.dimensions) & set(query.column_dimensions)
        if both:
            _invalid(f'"{sorted(both)[0]}" can\'t be both a row and a column dimension.')
        if len(set(query.dimensions)) != len(query.dimensions) or len(
            set(query.column_dimensions)
        ) != len(query.column_dimensions):
            _invalid("A dimension appears twice in the pivot table.")
        if grain is not None:
            _invalid("A pivot table has no time grain; use a time range to filter.")
