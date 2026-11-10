"""Queries on a dataset, always through run_query (all its safety layers apply)."""

from typing import Any

from sqlglot import exp

from app.datasets.checks import parse_metric_expression
from app.datasets.sql import DatasetSource, column, select_sql
from app.engines import ConnectionDetails
from app.query import DEFAULT_TIMEOUT_SECONDS, QueryResult, run_query

PREVIEW_ROWS = 100


def preview(
    details: ConnectionDetails,
    source: DatasetSource,
    limit: int = PREVIEW_ROWS,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> QueryResult:
    """SELECT * FROM <dataset>, at most `limit` rows. `truncated` tells if there are more.
    (No LIMIT in the SQL: run_query fetches at most limit + 1 rows and caps MySQL's LIMIT.)"""
    return run_query(
        details, select_sql(source, details.db_type), limit=limit, timeout_seconds=timeout_seconds
    )


def validate_metric(
    details: ConnectionDetails,
    source: DatasetSource,
    expression: str,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> QueryResult:
    """Run SELECT <expression> AS "value" FROM <dataset> LIMIT 1. Raises QueryError."""
    parsed = parse_metric_expression(expression, details.db_type)
    sql = select_sql(source, details.db_type, [parsed.as_("value", quoted=True)], limit=1)
    return run_query(details, sql, limit=1, timeout_seconds=timeout_seconds)


def time_extent(
    details: ConnectionDetails,
    source: DatasetSource,
    time_column: str,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> tuple[Any, Any]:
    """(MIN, MAX) of a time column over the whole dataset: one cheap aggregate row.
    Both are None when the dataset has no non-NULL values in that column."""
    col = column(time_column)
    sql = select_sql(
        source,
        details.db_type,
        [
            exp.Min(this=col.copy()).as_("min_value", quoted=True),
            exp.Max(this=col.copy()).as_("max_value", quoted=True),
        ],
    )
    result = run_query(details, sql, limit=1, timeout_seconds=timeout_seconds)
    row = result.rows[0] if result.rows else [None, None]
    return row[0], row[1]
