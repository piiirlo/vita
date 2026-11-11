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
from app.charts.timegrain import time_bucket
from app.charts.timerange import aligned_bounds
from app.datasets.checks import parse_metric_expression
from app.datasets.sql import column as sql_column
from app.datasets.sql import dialect_for, from_clause, quoted, source_of
from app.models import Dataset, DatasetColumn
from app.query import QueryError
from app.schemas.charts import (
    MAX_PIVOT_COLUMN_DIMENSIONS,
    MAX_PIVOT_ROW_DIMENSIONS,
    AdhocMetric,
    ChartQuery,
    Grain,
    MetricRef,
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

    def metric(self, ref: MetricRef) -> tuple[str, exp.Expr]:
        if isinstance(ref, str):
            saved = self.metrics.get(ref)
            if saved is None:
                _invalid(f"Unknown metric \"{ref}\". It isn't one of this dataset's metrics.")
            return saved.name, parse_metric_expression(saved.expression, self.db_type)
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

        time_col, grain = self.time_column(query, raw)
        conditions = self.conditions(query, time_col)

        metric_exprs: list[exp.Expr] = []
        if raw:
            for name in query.columns:
                self.add_output(name, sql_column(self.column(name, "columns").name), group=False)
        else:
            if time_col is not None and grain is not None:
                if time_col.name in query.dimensions or time_col.name == query.series:
                    _invalid(
                        f'"{time_col.name}" is already the time axis; don\'t also group by it.'
                    )
                bucket = time_bucket(sql_column(time_col.name), grain, self.db_type)
                self.add_output(time_col.name, bucket, group=True)
            for name in query.dimensions:
                self.add_output(
                    name, sql_column(self.group_column(name, "dimension").name), group=True
                )
            if query.series is not None:
                if query.series in query.dimensions:
                    _invalid(f'"{query.series}" is both a dimension and the series.')
                self.add_output(
                    query.series,
                    sql_column(self.group_column(query.series, "series").name),
                    group=True,
                )
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
            self.add_output(ROWS_PROBE_COLUMN, exp.Min(this=sql_column(time_col.name)), group=False)

        select = exp.select(*self.selects).from_(from_clause(source_of(self.dataset), self.db_type))
        if query.series is not None and query.series_limit is not None and metric_exprs:
            select = self.join_top_series(
                select, query.series, metric_exprs[0], conditions, query.series_limit
            )
        if conditions:
            select = select.where(exp.and_(*[c.copy() for c in conditions]))
        if self.group_by:
            select = select.group_by(*self.group_by)
        order = self.order(query, time_col if grain else None, raw)
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
        dims = [self.group_column(name, "dimension") for name in query.dimensions]
        if len(dims) == 2 and dims[0].name == dims[1].name:
            _invalid("Pick two different dimensions for the treemap's levels.")
        refs = [sql_column(d.name) for d in dims]
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
        rows = [self.group_column(n, "row dimension") for n in query.dimensions]
        cols = [self.group_column(n, "column dimension") for n in query.column_dimensions]
        metrics = [self.metric(ref) for ref in query.metrics]
        for d in [*rows, *cols]:
            self.outputs[d.name] = sql_column(d.name)
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

        def grouped_count(prefix: list[DatasetColumn]) -> exp.Expr:
            # How many of these are grouped: 1 - GROUPING(d) is 1 when d is grouped. They
            # are a prefix, so the count says exactly which ones.
            if not prefix:
                return exp.Literal.number(0)
            terms: list[exp.Expr] = [
                exp.Sub(
                    this=exp.Literal.number(1),
                    expression=exp.Anonymous(this="GROUPING", expressions=[sql_column(d.name)]),
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
                *[sql_column(d.name) for d in dims],
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
                    exp.Tuple(expressions=[sql_column(d.name) for d in [*rows[:i], *cols[:j]]])
                    for i, j in levels
                ]
                select.set("group", exp.Group(expressions=[exp.GroupingSets(expressions=sets)]))
            elif dims:
                select = select.group_by(*[sql_column(d.name) for d in dims])
            statement = select
        else:
            branches: list[exp.Select] = []
            for i, j in levels:
                grouped = [*rows[:i], *cols[:j]]
                names = {d.name for d in grouped}
                branch = exp.select(
                    *[
                        (sql_column(d.name) if d.name in names else exp.Null()).as_(
                            d.name, quoted=True
                        )
                        for d in dims
                    ],
                    exp.Literal.number(i).as_(ROW_LEVEL_COLUMN, quoted=True),
                    exp.Literal.number(j).as_(COL_LEVEL_COLUMN, quoted=True),
                    *metric_selects(),
                ).from_(source.copy())
                if where is not None:
                    branch = branch.where(where.copy())
                if grouped:
                    branch = branch.group_by(*[sql_column(d.name) for d in grouped])
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

    def time_column(
        self, query: ChartQuery, raw: bool
    ) -> tuple[DatasetColumn | None, Grain | None]:
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
        return col, time.grain

    def conditions(self, query: ChartQuery, time_col: DatasetColumn | None) -> list[exp.Expr]:
        conditions: list[exp.Expr] = []
        if time_col is not None and query.time is not None:
            start, end = aligned_bounds(query.time.range, self.today, query.time.grain)
            self.time_bounds = (start, end)
            ref = sql_column(time_col.name)
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
        series: str,
        first_metric: exp.Expr,
        conditions: list[exp.Expr],
        limit: int,
    ) -> exp.Select:
        """Keep only the top `limit` series by the first metric, computed in SQL. A JOIN, not
        IN (...): MySQL doesn't allow LIMIT inside an IN subquery. <=> keeps a NULL series."""
        ref = sql_column(series)
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
        self, query: ChartQuery, time_col: DatasetColumn | None, raw: bool
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
        if time_col is not None:
            order = [by(time_col.name, False)]
            if query.series is not None:
                order.append(by(query.series, False))
            return order
        if query.metrics:
            return [by(next(iter(self.metric_names(query))), True)]
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
    if query.series is not None and viz_type not in ("bar", "line", "area"):
        _invalid("Only bar and line charts (and area charts) have a series.")
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
    elif viz_type in ("bar", "combo"):
        name = "bar chart" if viz_type == "bar" else "combo chart"
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
    elif viz_type in ("line", "area"):
        name = "line chart" if viz_type == "line" else "area chart"
        if grain is None:
            _invalid(f"A {name} needs a time column and a time grain for its x axis.")
        if query.dimensions:
            _invalid(f"A {name}'s x axis is time; use the series to split it.")
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
