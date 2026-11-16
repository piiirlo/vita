"""Dashboard filters -> a chart query. No FastAPI imports.

A dashboard filter targets a chart by column name (the frontend sends only the filters that
target the chart). Here each one is merged into the chart's query when the chart's dataset
can take it, so the existing builder turns it into SQL (sqlglot literals, the same NULL
rules as chart filters) and the cache key (built from the final SQL) changes with it:

- time:   replaces the chart's own time range, on the chart's own time column (or the
          dataset's main one); skipped when there is none.
- values: `column IN (values)` (a null in the list also matches empty values); skipped
          when the dataset has no usable column of that name, or the values don't fit
          its type.
- range:  `column >= min` / `column <= max` on a number column; skipped otherwise.

An empty selection (no time range, no values, no bounds) filters nothing.
"""

from dataclasses import dataclass, field
from datetime import date

from sqlglot import exp

from app.charts.filters import ALLOWED_OPERATORS, date_literal, filter_condition
from app.charts.timerange import time_bounds
from app.datasets.sql import column as sql_column
from app.datasets.sql import dialect_for, from_clause, source_of
from app.datasets.timecols import time_value
from app.models import Dataset, DatasetColumn
from app.query import QueryError
from app.schemas.charts import AppliedDashboardFilter, ChartQuery, Filter, TimeSpec

# A values filter offers at most this many distinct values (search narrows them down).
MAX_COLUMN_VALUES = 1000


@dataclass
class MergedQuery:
    query: ChartQuery
    # Ids of the filters that changed the query.
    applied: list[str] = field(default_factory=list)


def is_active(f: AppliedDashboardFilter) -> bool:
    """Whether the selection filters anything at all."""
    match f.kind:
        case "time":
            return f.time_range is not None and f.time_range.kind != "none"
        case "values":
            return bool(f.values)
        case "range":
            return f.min is not None or f.max is not None


def _usable(dataset: Dataset, name: str | None) -> DatasetColumn | None:
    col = next((c for c in dataset.columns if c.name == name), None) if name else None
    if col is None or col.is_missing or col.is_hidden:
        return None
    return col


def _fits(filters: list[Filter], col: DatasetColumn) -> bool:
    """Whether the builder accepts these filters on this column (operator and value types)."""
    try:
        for f in filters:
            filter_condition(f, col, sql_column(col.name))
    except QueryError:
        return False
    return True


def _time(query: ChartQuery, dataset: Dataset, f: AppliedDashboardFilter, db_type: str) -> bool:
    assert f.time_range is not None
    name = (query.time.column if query.time else None) or dataset.main_time_column
    col = _usable(dataset, name)
    if col is None or not col.is_temporal:
        return False
    try:
        time_value(col, db_type)  # a time column that can't be read as dates
    except QueryError:
        return False
    grain = query.time.grain if query.time else None
    query.time = TimeSpec(column=col.name, grain=grain, range=f.time_range.model_copy())
    return True


def _values(query: ChartQuery, dataset: Dataset, f: AppliedDashboardFilter) -> bool:
    col = _usable(dataset, f.column)
    if col is None or "IN" not in ALLOWED_OPERATORS.get(col.effective_type, set()):
        return False
    new = [Filter(column=col.name, operator="IN", value=list(f.values or []))]
    if not _fits(new, col):
        return False
    query.filters.extend(new)
    return True


def _range(query: ChartQuery, dataset: Dataset, f: AppliedDashboardFilter) -> bool:
    col = _usable(dataset, f.column)
    if col is None or col.effective_type != "number":
        return False
    new: list[Filter] = []
    if f.min is not None:
        new.append(Filter(column=col.name, operator=">=", value=f.min))
    if f.max is not None:
        new.append(Filter(column=col.name, operator="<=", value=f.max))
    query.filters.extend(new)
    return True


def values_sql(
    dataset: Dataset,
    db_type: str,
    column: str,
    search: str | None,
    filters: list[AppliedDashboardFilter] | None = None,
    today: date | None = None,
) -> str:
    """SELECT DISTINCT <column> FROM <dataset> [WHERE ...] ORDER BY it: the choices of a values
    filter (run it with run_query and a limit). `search`: "contains", text columns only (like
    a LIKE chart filter). `filters`: the current values of the filters it depends on (City
    only shows the cities of the chosen Country), applied like on a chart; those the dataset
    can't take are skipped."""
    col = _usable(dataset, column)
    if col is None:
        raise QueryError("invalid", f'"{column}" is not a column of this dataset.')
    ref = sql_column(col.name)
    select = (
        exp.select(ref.copy())
        .distinct()
        .from_(from_clause(source_of(dataset), db_type))
        .order_by(ref.copy())
    )
    conditions = _conditions(dataset, db_type, filters or [], today or date.today())
    if search and search.strip() and col.effective_type == "string":
        like = Filter(column=col.name, operator="LIKE", value=search.strip())
        conditions.append(filter_condition(like, col, ref))
    for condition in conditions:
        select = select.where(condition)
    return select.sql(dialect=dialect_for(db_type))


def _conditions(
    dataset: Dataset, db_type: str, filters: list[AppliedDashboardFilter], today: date
) -> list[exp.Expr]:
    """WHERE conditions of dashboard filters on a plain SELECT of the dataset (a time filter
    uses the dataset's main time column)."""
    merged = merge_dashboard_filters(dataset, db_type, ChartQuery(dataset_id=dataset.id), filters)
    query = merged.query
    conditions: list[exp.Expr] = []
    if query.time is not None:
        time_col = _usable(dataset, query.time.column)
        assert time_col is not None  # merge only sets a usable time column
        start, end = time_bounds(query.time.range, today)
        value = time_value(time_col, db_type)
        if start is not None:
            conditions.append(exp.GTE(this=value.copy(), expression=date_literal(start)))
        if end is not None:
            conditions.append(exp.LT(this=value.copy(), expression=date_literal(end)))
    for f in query.filters:
        col = _usable(dataset, f.column)
        assert col is not None
        conditions.append(filter_condition(f, col, sql_column(col.name)))
    return conditions


def merge_dashboard_filters(
    dataset: Dataset, db_type: str, query: ChartQuery, filters: list[AppliedDashboardFilter]
) -> MergedQuery:
    """A copy of `query` with every applicable, active dashboard filter merged in."""
    merged = MergedQuery(query.model_copy(deep=True))
    for f in filters:
        if not is_active(f):
            continue
        match f.kind:
            case "time":
                ok = _time(merged.query, dataset, f, db_type)
            case "values":
                ok = _values(merged.query, dataset, f)
            case "range":
                ok = _range(merged.query, dataset, f)
        if ok and f.id not in merged.applied:
            merged.applied.append(f.id)
    return merged
