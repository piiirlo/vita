"""Column values of the datasets API: the distinct values behind a dashboard values filter
(GET /api/datasets/{id}/values; the route itself is in app.api.datasets)."""

import logging
from dataclasses import asdict
from datetime import datetime
from typing import Any

from fastapi import HTTPException, status
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.datasets_common import details_of, query_error
from app.charts import cache as chart_cache
from app.charts.dashboard_filters import values_sql
from app.models import Dataset
from app.query import DEFAULT_TIMEOUT_SECONDS, QueryError, run_query
from app.schemas.charts import AppliedDashboardFilter
from app.schemas.datasets import ColumnValuesOut

log = logging.getLogger(__name__)

_FILTERS = TypeAdapter(list[AppliedDashboardFilter])


def parse_filters(filters: str | None) -> list[AppliedDashboardFilter]:
    """The `filters` query parameter: a JSON list of dashboard filters (422 if invalid)."""
    try:
        return _FILTERS.validate_json(filters) if filters else []
    except ValidationError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Invalid filters: {exc.errors()[0]['msg']}"
        ) from None


def column_values_out(
    db: Session,
    dataset: Dataset,
    column: str,
    q: str | None,
    parent_filters: list[AppliedDashboardFilter],
    *,
    refresh: bool,
    limit: int,
) -> ColumnValuesOut:
    """Run (or read from the chart cache) the DISTINCT query, at most `limit` values."""
    details = details_of(dataset)
    try:
        sql = values_sql(dataset, details.db_type, column, q, parent_filters)
    except QueryError as error:
        query_error(error)
    connection = dataset.connection
    key = chart_cache.cache_key(connection.id, connection.updated_at, sql, limit)
    if not refresh:
        hit = chart_cache.get(db, key)
        if hit is not None:
            return _values_out(column, hit.result, hit.created_at)
    connection_id = connection.id
    db.close()
    try:
        result = run_query(details, sql, limit=limit, timeout_seconds=DEFAULT_TIMEOUT_SECONDS)
    except QueryError as error:
        query_error(error)
    raw = asdict(result)
    try:
        chart_cache.put(db, key, connection_id, raw, chart_cache.DEFAULT_TTL_SECONDS)
    except SQLAlchemyError:
        db.rollback()
        log.exception("Couldn't cache column values")
    finally:
        db.close()
    return _values_out(column, raw, None)


def _values_out(column: str, result: dict[str, Any], cached_at: datetime | None) -> ColumnValuesOut:
    return ColumnValuesOut(
        column=column,
        values=[row[0] for row in result["rows"]],
        truncated=bool(result["truncated"]),
        cached_at=cached_at,
    )
