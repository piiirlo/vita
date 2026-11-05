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
from app.schemas.charts import AdhocMetric, ChartQuery, MetricRef, VizType

TOP_SERIES_ALIAS = "top_series"
TOP_SERIES_COLUMN = "__series"

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
        self.selects: list[exp.Expression] = []
        self.group_by: list[exp.Expression] = []
        self.outputs: dict[str, exp.Expression] = {}  # output name -> expression

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

    def metric(self, ref: MetricRef) -> tuple[str, exp.Expression]:
        if isinstance(ref, str):
            saved = self.metrics.get(ref)
            if saved is None:
                _invalid(f'Unknown metric "{ref}". It isn\'t one of this dataset\'s metrics.')
            return saved.name, parse_metric_expression(saved.expression, self.db_type)
        return ref.name, self.adhoc_metric(ref)

    def adhoc_metric(self, ref: AdhocMetric) -> exp.Expression:
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

    def add_output(self, name: str, expression: exp.Expression, group: bool) -> None:
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

        time_col, grain = self.time_column(query, raw)
        conditions = self.conditions(query, time_col)

        metric_exprs: list[exp.Expression] = []
        if raw:
            for name in query.columns:
                self.add_output(name, sql_column(self.column(name, "columns").name), group=False)
        else:
            if time_col is not None and grain is not None:
                if time_col.name in query.dimensions or time_col.name == query.series:
                    _invalid(f'"{time_col.name}" is already the time axis; don\'t also group by it.')
                bucket = time_bucket(sql_column(time_col.name), grain, self.db_type)
                self.add_output(time_col.name, bucket, group=True)
            for name in query.dimensions:
                self.add_output(name, sql_column(self.group_column(name, "dimension").name), group=True)
            if query.series is not None:
                if query.series in query.dimensions:
                    _invalid(f'"{query.series}" is both a dimension and the series.')
                self.add_output(
                    query.series, sql_column(self.group_column(query.series, "series").name), group=True
                )
            for ref in query.metrics:
                name, expression = self.metric(ref)
                metric_exprs.append(expression)
                self.add_output(name, expression, group=False)

        select = exp.select(*self.selects).from_(from_clause(source_of(self.dataset), self.db_type))
        if query.series is not None and query.series_limit is not None and metric_exprs:
            select = self.join_top_series(select, query.series, metric_exprs[0], conditions, query.series_limit)
        if conditions:
            select = select.where(exp.and_(*[c.copy() for c in conditions]))
        if self.group_by:
            select = select.group_by(*self.group_by)
        order = self.order(query, time_col if grain else None, raw)
        if order:
            select = select.order_by(*order)
        select = select.limit(query.row_limit + 1)
        return BuiltChartQuery(select.sql(dialect=self.dialect, pretty=True), query.row_limit)

    def time_column(self, query: ChartQuery, raw: bool) -> tuple[DatasetColumn | None, str | None]:
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

    def conditions(self, query: ChartQuery, time_col: DatasetColumn | None) -> list[exp.Expression]:
        conditions: list[exp.Expression] = []
        if time_col is not None and query.time is not None:
            start, end = aligned_bounds(query.time.range, self.today, query.time.grain)
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
        first_metric: exp.Expression,
        conditions: list[exp.Expression],
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

    def order(self, query: ChartQuery, time_col: DatasetColumn | None, raw: bool) -> list[exp.Ordered]:
        def by(name: str, desc: bool) -> exp.Ordered:
            return _ordered(exp.Column(this=quoted(name)), desc)

        if query.order_by is not None:
            name = query.order_by.by
            if name not in self.outputs:
                _invalid(f'Can\'t order by "{name}": it isn\'t a metric or column of this chart.')
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


def _ordered(expression: exp.Expression, desc: bool) -> exp.Ordered:
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
    if query.series is not None and viz_type not in ("bar", "line"):
        _invalid("Only bar and line charts have a series.")
    if viz_type == "table":
        if not (query.metrics or query.dimensions or grain):
            _invalid("Pick at least one metric or dimension (or columns for raw records).")
    elif not query.metrics:
        _invalid("Pick at least one metric.")
    if viz_type == "big_number":
        if len(query.metrics) != 1:
            _invalid("A big number shows exactly one metric.")
        if query.dimensions:
            _invalid("A big number can't have dimensions.")
    elif viz_type == "bar":
        if len(query.dimensions) > 1 or (grain and query.dimensions):
            _invalid("A bar chart's x axis is either one dimension or a time grain, not both.")
        if not (grain or query.dimensions):
            _invalid("Pick the bar chart's x axis: a dimension or a time grain.")
    elif viz_type == "line":
        if grain is None:
            _invalid("A line chart needs a time column and a time grain for its x axis.")
        if query.dimensions:
            _invalid("A line chart's x axis is time; use the series to split lines.")
