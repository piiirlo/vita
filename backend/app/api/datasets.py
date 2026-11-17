"""Datasets API: /api/datasets.

Anything that talks to the user database (sync, preview, metric validation) goes through
app.datasets, which uses run_query. The metadata-DB session is closed while those run.

This module has the dataset endpoints and includes the rest, split by job:
datasets_common (loading, response shape), datasets_usage (what charts / filters use),
datasets_columns (column rules), datasets_metrics (metric endpoints), datasets_values
(column values).
"""

import logging
from dataclasses import asdict
from typing import Annotated

import psycopg
from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.api import datasets_metrics
from app.api.connections import get_connection_or_404, saved_connection_details
from app.api.datasets_columns import (
    apply_column_settings,
    delete_missing_columns,
    main_time_column_problem,
)
from app.api.datasets_common import (
    QUERY_ERROR_RESPONSES,
    DbSession,
    check_name_free,
    clean,
    commit,
    dataset_out,
    details_of,
    get_dataset_or_404,
    list_item_fields,
    query_error,
    touch,
)
from app.api.datasets_usage import chart_usages, check_dataset_unused, check_table_unused
from app.api.datasets_values import column_values_out, parse_filters
from app.api.projects import resolve_project
from app.charts.dashboard_filters import MAX_COLUMN_VALUES
from app.datasets import (
    COUNT_METRIC,
    DatasetSource,
    check_dataset_sql,
    detect_columns,
    merge_columns,
    preview,
    select_sql,
    source_of,
    time_extent,
)
from app.datasets.sync import detect_number_stats
from app.datasets.timecols import apply_pending, check_pending, has_pending
from app.models import Dataset, DatasetMetric
from app.query import QueryError
from app.schemas.datasets import (
    ColumnValuesOut,
    DatasetCreate,
    DatasetListItem,
    DatasetOut,
    DatasetUpdate,
    PreviewOut,
    SyncOut,
    SyncSummary,
    TimeExtentOut,
)
from app.uploads.datasets import is_upload_dataset
from app.uploads.importer import drop_table as drop_upload_table

log = logging.getLogger(__name__)

router = APIRouter()


def ensure_time_columns(db: Session, dataset_id: int) -> Dataset:
    """The dataset, after checking its "pending" time columns (number / text columns marked
    temporal before Part 13): year numbers and text dates are kept as such, anything else is
    unmarked, each with a note. Lazy (dataset page, Sync, preview, chart data), never at
    startup. Best effort: if the database can't be reached they stay pending, and charts
    say so."""
    dataset = get_dataset_or_404(db, dataset_id)
    if not has_pending(dataset):
        return dataset
    details = details_of(dataset)
    source = source_of(dataset)
    columns = list(dataset.columns)
    db.close()
    try:
        results = check_pending(details, source, columns)
    except QueryError:
        log.warning("Couldn't check the time columns of dataset %s", dataset_id, exc_info=True)
        return get_dataset_or_404(db, dataset_id)
    dataset = get_dataset_or_404(db, dataset_id)
    apply_pending(dataset, results)
    touch(dataset)
    db.commit()
    db.expire_all()
    return get_dataset_or_404(db, dataset_id)


# ---------- datasets ----------


@router.get("", response_model=list[DatasetListItem])
def list_datasets(
    db: DbSession,
    q: Annotated[str | None, Query(max_length=200)] = None,
    connection_id: int | None = None,
    project_id: int | None = None,
) -> list[DatasetListItem]:
    stmt = select(Dataset).options(
        selectinload(Dataset.connection),
        selectinload(Dataset.columns),
        selectinload(Dataset.metrics),
    )
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Dataset.name.ilike(pattern),
                Dataset.description.ilike(pattern),
                Dataset.table_name.ilike(pattern),
                Dataset.schema.ilike(pattern),
                Dataset.sql.ilike(pattern),
            )
        )
    if connection_id is not None:
        stmt = stmt.where(Dataset.connection_id == connection_id)
    if project_id is not None:
        stmt = stmt.where(Dataset.project_id == project_id)
    stmt = stmt.order_by(Dataset.updated_at.desc(), Dataset.id.desc())
    return [DatasetListItem(**list_item_fields(d)) for d in db.scalars(stmt)]


@router.post(
    "",
    response_model=DatasetOut,
    status_code=status.HTTP_201_CREATED,
    responses=QUERY_ERROR_RESPONSES,
)
def create_dataset(payload: DatasetCreate, db: DbSession) -> DatasetOut:
    """Create a dataset and read its columns. Nothing is saved if that fails."""
    name = payload.name.strip()
    conn = get_connection_or_404(db, payload.connection_id)
    project_id = resolve_project(db, payload.project_id, conn.project_id, "The connection")
    check_name_free(db, name, project_id)
    db.commit()  # keep a default project created just now
    details = saved_connection_details(conn)
    source = DatasetSource(
        payload.kind,
        schema=payload.schema_ if payload.kind == "table" else None,
        table_name=payload.table_name if payload.kind == "table" else None,
        sql=payload.sql if payload.kind == "sql" else None,
    )
    db.close()  # don't hold a metadata-DB connection while the user DB is queried

    try:
        if source.kind == "sql":
            check_dataset_sql(source.sql or "", details.db_type)
        detected = detect_columns(details, source)
    except QueryError as error:
        query_error(error)
    stats = detect_number_stats(details, source, detected)

    dataset = Dataset(
        project_id=project_id,
        name=name,
        description=clean(payload.description),
        connection_id=payload.connection_id,
        kind=source.kind,
        schema=source.schema,
        table_name=source.table_name,
        sql=source.sql,
    )
    merge_columns(dataset, detected, stats)
    dataset.metrics.append(DatasetMetric(**COUNT_METRIC, is_builtin=True))
    db.add(dataset)
    commit(db, f'A dataset named "{name}" already exists')
    return dataset_out(db, get_dataset_or_404(db, dataset.id))


@router.get("/{dataset_id}", response_model=DatasetOut)
def get_dataset(dataset_id: int, db: DbSession) -> DatasetOut:
    return dataset_out(db, ensure_time_columns(db, dataset_id))


@router.delete("/{dataset_id}/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_note(dataset_id: int, note_id: str, db: DbSession) -> Response:
    dataset = get_dataset_or_404(db, dataset_id)
    notes = [n for n in dataset.notes or [] if n.get("id") != note_id]
    dataset.notes = notes or None
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{dataset_id}", response_model=DatasetOut, responses=QUERY_ERROR_RESPONSES)
def update_dataset(dataset_id: int, payload: DatasetUpdate, db: DbSession) -> DatasetOut:
    dataset = get_dataset_or_404(db, dataset_id)
    name = payload.name.strip()
    check_name_free(db, name, dataset.project_id, dataset_id)

    if payload.sql is not None and dataset.kind != "sql":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only SQL datasets have SQL")
    if payload.sql is not None and not payload.sql.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The SQL is empty")
    sql_changed = payload.sql is not None and payload.sql.strip() != (dataset.sql or "").strip()

    if sql_changed:
        details = details_of(dataset)
        new_source = DatasetSource("sql", sql=payload.sql)
        db.close()
        try:
            check_dataset_sql(payload.sql or "", details.db_type)
            detected = detect_columns(details, new_source)
        except QueryError as error:
            query_error(error)
        dataset = get_dataset_or_404(db, dataset_id)
        dataset.sql = payload.sql
        merge_columns(dataset, detected)

    dataset.name = name
    dataset.description = clean(payload.description)

    usages = chart_usages(db, dataset)
    apply_column_settings(dataset, payload.columns or [], usages)
    delete_missing_columns(dataset, payload.delete_column_ids, usages)

    main = payload.main_time_column or None
    problem = main_time_column_problem(dataset, main)
    if problem is None:
        dataset.main_time_column = main
    elif not sql_changed:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, problem)
    # else: the new SQL dropped that column; keep what the sync chose.

    touch(dataset)
    commit(db, f'A dataset named "{name}" already exists')
    db.expire_all()
    return dataset_out(db, get_dataset_or_404(db, dataset_id))


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, db: DbSession, drop_table: bool = False) -> Response:
    """With `drop_table` (datasets made from an uploaded file), its table in the Uploads
    database is dropped too, unless another dataset reads it."""
    dataset = get_dataset_or_404(db, dataset_id)
    check_dataset_unused(db, dataset)
    table = dataset.table_name if drop_table and is_upload_dataset(dataset) else None
    if drop_table and table is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Only datasets made from an uploaded file have a table that can be deleted with them.",
        )
    if table is not None:
        check_table_unused(db, dataset, table)
    db.delete(dataset)
    db.flush()
    if table is not None:
        # Dropped before the commit: if the drop fails, the dataset stays too.
        try:
            drop_upload_table(table)
        except psycopg.Error as exc:
            db.rollback()
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                f"The table “{table}” couldn't be deleted, so the dataset was kept: {exc}",
            ) from None
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{dataset_id}/sync", response_model=SyncOut, responses=QUERY_ERROR_RESPONSES)
def sync_dataset(dataset_id: int, db: DbSession) -> SyncOut:
    """Re-read the columns from the database, keeping the user's settings."""
    dataset = get_dataset_or_404(db, dataset_id)
    details = details_of(dataset)
    source = source_of(dataset)
    db.close()
    try:
        detected = detect_columns(details, source)
    except QueryError as error:
        query_error(error)
    stats = detect_number_stats(details, source, detected)

    dataset = get_dataset_or_404(db, dataset_id)
    result = merge_columns(dataset, detected, stats)
    touch(dataset)
    db.commit()
    db.expire_all()
    dataset = ensure_time_columns(db, dataset_id)
    return SyncOut(dataset=dataset_out(db, dataset), summary=SyncSummary(**asdict(result)))


@router.get("/{dataset_id}/preview", response_model=PreviewOut, responses=QUERY_ERROR_RESPONSES)
def preview_dataset(dataset_id: int, db: DbSession) -> PreviewOut:
    """The first 100 rows: SELECT * FROM <dataset>."""
    dataset = ensure_time_columns(db, dataset_id)
    details = details_of(dataset)
    source = source_of(dataset)
    db.close()
    try:
        sql = select_sql(source, details.db_type)
        result = preview(details, source)
    except QueryError as error:
        query_error(error)
    return PreviewOut(**asdict(result), sql=sql)


@router.get("/{dataset_id}/values", response_model=ColumnValuesOut, responses=QUERY_ERROR_RESPONSES)
def column_values(
    dataset_id: int,
    db: DbSession,
    column: Annotated[str, Query(min_length=1, max_length=255)],
    q: Annotated[str | None, Query(max_length=200)] = None,
    filters: Annotated[str | None, Query(max_length=100_000)] = None,
    refresh: bool = False,
) -> ColumnValuesOut:
    """The distinct values of a column (at most 1000, sorted; `q` = contains, text columns
    only): the choices of a dashboard values filter. `filters`: a JSON list of dashboard
    filters (as sent to chart-data) that limit the values: the filters it depends on.
    Read-only via run_query, cached like chart data (10 minutes)."""
    parent_filters = parse_filters(filters)
    dataset = ensure_time_columns(db, dataset_id)
    return column_values_out(
        db, dataset, column, q, parent_filters, refresh=refresh, limit=MAX_COLUMN_VALUES
    )


@router.get(
    "/{dataset_id}/time-extent", response_model=TimeExtentOut, responses=QUERY_ERROR_RESPONSES
)
def dataset_time_extent(dataset_id: int, db: DbSession, column: str | None = None) -> TimeExtentOut:
    """MIN and MAX of a time column (default: the main time column), for "this dataset has
    data from A to B" when a chart's time range is empty. One aggregate row, via run_query."""
    dataset = ensure_time_columns(db, dataset_id)
    name = column or dataset.main_time_column
    if not name:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Pick a time column: this dataset has no main time column"
        )
    col = next((c for c in dataset.columns if c.name == name), None)
    if col is None or col.is_missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f'"{name}" is not a column of this dataset'
        )
    if not col.is_temporal:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f'"{name}" is not a time column')
    details = details_of(dataset)
    source = source_of(dataset)
    db.close()
    try:
        low, high = time_extent(details, source, col)
    except QueryError as error:
        query_error(error)
    return TimeExtentOut(
        column=name,
        min=None if low is None else str(low),
        max=None if high is None else str(high),
    )


# ---------- metrics (app.api.datasets_metrics) ----------

router.include_router(datasets_metrics.router)
