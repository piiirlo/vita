"""Datasets API: /api/datasets.

Anything that talks to the user database (sync, preview, metric validation) goes through
app.datasets, which uses run_query. The metadata-DB session is closed while those run.
"""

import logging
from dataclasses import asdict
from typing import Annotated, NoReturn

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.connections import get_connection_or_404, saved_connection_details
from app.charts.usage import GROUP, TIME, QueryUsage, query_usage, used_by_message
from app.datasets import (
    COUNT_METRIC,
    DatasetSource,
    check_dataset_sql,
    detect_columns,
    merge_columns,
    metric_warning,
    parse_metric_expression,
    preview,
    select_sql,
    source_of,
    sqllab_sql,
    time_extent,
    validate_metric,
)
from app.datasets.checks import query_warnings
from app.datasets.sql import parse_dataset_query
from app.datasets.sync import detect_number_stats
from app.datasets.timecols import (
    DATE_FORMAT_LABELS,
    add_note,
    apply_pending,
    check_pending,
    check_text_dates,
    has_pending,
    number_stats,
    text_date_note,
)
from app.db import get_db
from app.engines import ConnectionDetails
from app.models import Chart, Dataset, DatasetColumn, DatasetMetric
from app.query import QueryError
from app.schemas.charts import ChartParams
from app.schemas.datasets import (
    ColumnSettings,
    DatasetColumnOut,
    DatasetCreate,
    DatasetListItem,
    DatasetMetricOut,
    DatasetOut,
    DatasetUpdate,
    MetricIn,
    MetricValidateIn,
    MetricValidateOut,
    PreviewOut,
    SyncOut,
    SyncSummary,
    TimeExtentOut,
)
from app.schemas.query import QueryErrorOut
from app.uploads.datasets import is_upload_dataset, table_users, upload_source
from app.uploads.importer import drop_table as drop_upload_table

log = logging.getLogger(__name__)

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]


QUERY_ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    400: {"description": "The query on the user database failed", "model": QueryErrorOut}
}


# ---------- helpers ----------


def _query_error(error: QueryError) -> NoReturn:
    raise HTTPException(status.HTTP_400_BAD_REQUEST, QueryErrorOut(**asdict(error)).model_dump())


def get_dataset_or_404(db: Session, dataset_id: int) -> Dataset:
    dataset = db.scalar(
        select(Dataset)
        .where(Dataset.id == dataset_id)
        .options(
            selectinload(Dataset.connection),
            selectinload(Dataset.columns),
            selectinload(Dataset.metrics),
        )
    )
    if dataset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    return dataset


def _details(dataset: Dataset) -> ConnectionDetails:
    return saved_connection_details(dataset.connection)


def ensure_time_columns(db: Session, dataset_id: int) -> Dataset:
    """The dataset, after checking its "pending" time columns (number / text columns marked
    temporal before Part 13): year numbers and text dates are kept as such, anything else is
    unmarked, each with a note. Lazy (dataset page, Sync, preview, chart data), never at
    startup. Best effort: if the database can't be reached they stay pending, and charts
    say so."""
    dataset = get_dataset_or_404(db, dataset_id)
    if not has_pending(dataset):
        return dataset
    details = _details(dataset)
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
    _touch(dataset)
    db.commit()
    db.expire_all()
    return get_dataset_or_404(db, dataset_id)


def _check_name_free(db: Session, name: str, dataset_id: int | None = None) -> None:
    stmt = select(Dataset.id).where(func.lower(Dataset.name) == name.lower())
    if dataset_id is not None:
        stmt = stmt.where(Dataset.id != dataset_id)
    if db.scalar(stmt) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f'A dataset named "{name}" already exists')


def _commit(db: Session, conflict_message: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, conflict_message) from None


def _touch(dataset: Dataset) -> None:
    """Column and metric edits don't change the datasets row itself; bump updated_at."""
    dataset.updated_at = func.now()


def _warnings(dataset: Dataset) -> list[str]:
    if dataset.kind != "sql" or not dataset.sql:
        return []
    try:
        return query_warnings(parse_dataset_query(dataset.sql, dataset.connection.db_type))
    except QueryError:
        return []


def _list_item_fields(dataset: Dataset) -> dict[str, object]:
    return {
        "id": dataset.id,
        "name": dataset.name,
        "description": dataset.description,
        "connection_id": dataset.connection_id,
        "connection_name": dataset.connection_name,
        "kind": dataset.kind,
        "schema": dataset.schema,
        "table_name": dataset.table_name,
        "column_count": sum(1 for c in dataset.columns if not c.is_missing),
        "metric_count": len(dataset.metrics),
        "created_at": dataset.created_at,
        "updated_at": dataset.updated_at,
        "is_upload": is_upload_dataset(dataset),
    }


def _out(db: Session, dataset: Dataset) -> DatasetOut:
    db_type = dataset.connection.db_type
    return DatasetOut(
        **_list_item_fields(dataset),
        db_type=db_type,
        sql=dataset.sql,
        main_time_column=dataset.main_time_column,
        columns=[DatasetColumnOut.model_validate(c) for c in dataset.columns],
        metrics=[DatasetMetricOut.model_validate(m) for m in dataset.metrics],
        warnings=_warnings(dataset),
        sqllab_sql=sqllab_sql(source_of(dataset), db_type),
        upload_source=upload_source(db, dataset),
        notes=dataset.notes or [],
    )


def _main_time_column_problem(dataset: Dataset, name: str | None) -> str | None:
    if name is None:
        return None
    col = next((c for c in dataset.columns if c.name == name), None)
    if col is None or col.is_missing:
        return f'Main time column "{name}" is not a column of this dataset'
    if not col.is_temporal:
        return f'Main time column "{name}" must be marked as temporal'
    return None


def _chart_usages(db: Session, dataset: Dataset) -> list[tuple[str, QueryUsage]]:
    """(chart name, what it uses) for every saved chart on this dataset."""
    usages: list[tuple[str, QueryUsage]] = []
    for chart in db.scalars(select(Chart).where(Chart.dataset_id == dataset.id)):
        try:
            params = ChartParams.model_validate(chart.params)
        except ValueError:
            continue  # unreadable params can't be broken further
        usages.append((chart.name, query_usage(params.query, dataset.main_time_column)))
    return usages


def _blocked(what: str, chart_names: list[str]) -> NoReturn:
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        {"message": used_by_message(what, chart_names), "charts": sorted(chart_names)},
    )


def _check_column_change(
    usages: list[tuple[str, QueryUsage]],
    col: DatasetColumn,
    *,
    removed: bool = False,
    hidden: bool = False,
    dimension: bool = True,
    temporal: bool = True,
) -> None:
    """Refuse a column change that would break saved charts using that column."""
    breaking: list[str] = []
    for chart_name, usage in usages:
        roles = usage.columns.get(col.name)
        if not roles:
            continue
        if (
            removed
            or (hidden and not col.is_hidden)
            or (GROUP in roles and not (dimension or temporal))
            or (TIME in roles and not temporal)
        ):
            breaking.append(chart_name)
    if breaking:
        _blocked(f'Column "{col.name}"', breaking)


def _clean(text: str | None) -> str | None:
    return (text or "").strip() or None


def _time_kinds(
    dataset: Dataset, settings_list: list[ColumnSettings]
) -> dict[int, tuple[str | None, str | None]]:
    """(time_kind, text_date_format) for every column in the payload. Marking a column as
    time is only allowed for dates and datetimes, numbers that are all years (a year
    number) and text that reads as dates (a text date; values that don't are counted in a
    note). Checking runs queries on the user database (only for columns that change)."""
    out: dict[int, tuple[str | None, str | None]] = {}
    by_id = {c.id: c for c in dataset.columns}
    numbers: list[DatasetColumn] = []
    texts: list[tuple[DatasetColumn, ColumnSettings]] = []
    for settings in settings_list:
        col = by_id[settings.id]
        new_type = settings.generic_type_override or col.generic_type
        if not settings.is_temporal or new_type in ("date", "datetime"):
            out[col.id] = (None, None)
        elif (
            col.is_temporal
            and col.time_kind is not None
            and col.effective_type == new_type
            and settings.text_date_format in (None, col.text_date_format)
        ):
            out[col.id] = (col.time_kind, col.text_date_format)  # unchanged (or pending)
        elif new_type == "number":
            numbers.append(col)
        elif new_type == "string":
            texts.append((col, settings))
        else:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"“{col.name}” ({new_type}) can't be a time column. Time columns are "
                "dates, datetimes, years (whole numbers like 2024) or text dates.",
            )
    if not numbers and not texts:
        return out
    details = _details(dataset)
    source = source_of(dataset)
    try:
        stats = number_stats(details, source, [c.name for c in numbers])
        for col in numbers:
            if not stats[col.name].fits_years():
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"“{col.name}” can't be a time column: its values aren't years "
                    "(whole numbers like 2024, between 1000 and 9999).",
                )
            out[col.id] = ("year_number", None)
        for col, settings in texts:
            check = check_text_dates(details, source, col.name, settings.text_date_format)
            if check.order is None:
                why = (
                    "its dates read both as day/month and month/day. Pick the date order."
                    if check.ambiguous
                    else "its values don't look like dates (e.g. 2024-03-15 or 15/03/2024)."
                )
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"“{col.name}” can't be a time column: {why}",
                )
            if check.values and check.failures == check.values:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"“{col.name}” can't be a time column: none of its values are "
                    f"dates in {DATE_FORMAT_LABELS[check.order]}. Pick another date order.",
                )
            note = text_date_note(col.name, check)
            if note:
                add_note(dataset, note)
            out[col.id] = ("text_date", check.order)
    except QueryError as error:
        _query_error(error)
    return out


# ---------- datasets ----------


@router.get("", response_model=list[DatasetListItem])
def list_datasets(
    db: DbSession,
    q: Annotated[str | None, Query(max_length=200)] = None,
    connection_id: int | None = None,
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
    stmt = stmt.order_by(Dataset.updated_at.desc(), Dataset.id.desc())
    return [DatasetListItem(**_list_item_fields(d)) for d in db.scalars(stmt)]


@router.post(
    "",
    response_model=DatasetOut,
    status_code=status.HTTP_201_CREATED,
    responses=QUERY_ERROR_RESPONSES,
)
def create_dataset(payload: DatasetCreate, db: DbSession) -> DatasetOut:
    """Create a dataset and read its columns. Nothing is saved if that fails."""
    name = payload.name.strip()
    _check_name_free(db, name)
    conn = get_connection_or_404(db, payload.connection_id)
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
        _query_error(error)
    stats = detect_number_stats(details, source, detected)

    dataset = Dataset(
        name=name,
        description=_clean(payload.description),
        connection_id=payload.connection_id,
        kind=source.kind,
        schema=source.schema,
        table_name=source.table_name,
        sql=source.sql,
    )
    merge_columns(dataset, detected, stats)
    dataset.metrics.append(DatasetMetric(**COUNT_METRIC, is_builtin=True))
    db.add(dataset)
    _commit(db, f'A dataset named "{name}" already exists')
    return _out(db, get_dataset_or_404(db, dataset.id))


@router.get("/{dataset_id}", response_model=DatasetOut)
def get_dataset(dataset_id: int, db: DbSession) -> DatasetOut:
    return _out(db, ensure_time_columns(db, dataset_id))


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
    _check_name_free(db, name, dataset_id)

    if payload.sql is not None and dataset.kind != "sql":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only SQL datasets have SQL")
    if payload.sql is not None and not payload.sql.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The SQL is empty")
    sql_changed = payload.sql is not None and payload.sql.strip() != (dataset.sql or "").strip()

    if sql_changed:
        details = _details(dataset)
        new_source = DatasetSource("sql", sql=payload.sql)
        db.close()
        try:
            check_dataset_sql(payload.sql or "", details.db_type)
            detected = detect_columns(details, new_source)
        except QueryError as error:
            _query_error(error)
        dataset = get_dataset_or_404(db, dataset_id)
        dataset.sql = payload.sql
        merge_columns(dataset, detected)

    dataset.name = name
    dataset.description = _clean(payload.description)

    usages = _chart_usages(db, dataset)
    by_id = {c.id: c for c in dataset.columns}
    for settings in payload.columns or []:
        if settings.id not in by_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Column {settings.id} is not part of this dataset"
            )
    time_kinds = _time_kinds(dataset, payload.columns or [])
    for settings in payload.columns or []:
        col = by_id[settings.id]
        _check_column_change(
            usages,
            col,
            hidden=settings.is_hidden,
            dimension=settings.is_dimension,
            temporal=settings.is_temporal,
        )
        col.label = _clean(settings.label)
        col.generic_type_override = settings.generic_type_override
        col.is_temporal = settings.is_temporal
        col.time_kind, col.text_date_format = time_kinds[col.id]
        if settings.is_identifier is not None:
            col.is_identifier = settings.is_identifier
        if col.is_temporal:
            col.looks_like_years = False
        col.is_dimension = settings.is_dimension
        col.is_hidden = settings.is_hidden
        col.description = _clean(settings.description)
        if settings.value_labels is not None:
            labels = {k: v.strip() for k, v in settings.value_labels.items() if v.strip()}
            col.value_labels = labels or None

    for column_id in payload.delete_column_ids:
        missing_col = by_id.get(column_id)
        if missing_col is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Column {column_id} is not part of this dataset"
            )
        col = missing_col
        if not col.is_missing:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f'Column "{col.name}" still exists in the database; hide it instead',
            )
        _check_column_change(usages, col, removed=True)
        dataset.columns.remove(col)

    main = payload.main_time_column or None
    problem = _main_time_column_problem(dataset, main)
    if problem is None:
        dataset.main_time_column = main
    elif not sql_changed:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, problem)
    # else: the new SQL dropped that column; keep what the sync chose.

    _touch(dataset)
    _commit(db, f'A dataset named "{name}" already exists')
    db.expire_all()
    return _out(db, get_dataset_or_404(db, dataset_id))


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, db: DbSession, drop_table: bool = False) -> Response:
    """With `drop_table` (datasets made from an uploaded file), its table in the Uploads
    database is dropped too, unless another dataset reads it."""
    dataset = get_dataset_or_404(db, dataset_id)
    used_by = list(
        db.scalars(select(Chart.name).where(Chart.dataset_id == dataset.id).order_by(Chart.name))
    )
    if used_by:
        noun = "chart" if len(used_by) == 1 else "charts"
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": f"This dataset is used by {len(used_by)} {noun}: "
                f"{', '.join(used_by)}. Delete those first.",
                "charts": used_by,
            },
        )
    table = dataset.table_name if drop_table and is_upload_dataset(dataset) else None
    if drop_table and table is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Only datasets made from an uploaded file have a table that can be deleted with them.",
        )
    if table is not None:
        others = table_users(db, dataset)
        if others:
            noun = "dataset uses" if len(others) == 1 else "datasets use"
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "message": f"The table “{table}” can't be deleted: {len(others)} other "
                    f"{noun} it ({', '.join(others)}). Delete only the dataset, or those first.",
                    "datasets": others,
                },
            )
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
    details = _details(dataset)
    source = source_of(dataset)
    db.close()
    try:
        detected = detect_columns(details, source)
    except QueryError as error:
        _query_error(error)
    stats = detect_number_stats(details, source, detected)

    dataset = get_dataset_or_404(db, dataset_id)
    result = merge_columns(dataset, detected, stats)
    _touch(dataset)
    db.commit()
    db.expire_all()
    dataset = ensure_time_columns(db, dataset_id)
    return SyncOut(dataset=_out(db, dataset), summary=SyncSummary(**asdict(result)))


@router.get("/{dataset_id}/preview", response_model=PreviewOut, responses=QUERY_ERROR_RESPONSES)
def preview_dataset(dataset_id: int, db: DbSession) -> PreviewOut:
    """The first 100 rows: SELECT * FROM <dataset>."""
    dataset = ensure_time_columns(db, dataset_id)
    details = _details(dataset)
    source = source_of(dataset)
    db.close()
    try:
        sql = select_sql(source, details.db_type)
        result = preview(details, source)
    except QueryError as error:
        _query_error(error)
    return PreviewOut(**asdict(result), sql=sql)


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
    details = _details(dataset)
    source = source_of(dataset)
    db.close()
    try:
        low, high = time_extent(details, source, col)
    except QueryError as error:
        _query_error(error)
    return TimeExtentOut(
        column=name,
        min=None if low is None else str(low),
        max=None if high is None else str(high),
    )


# ---------- metrics ----------


def _metric_or_404(dataset: Dataset, metric_id: int) -> DatasetMetric:
    metric = next((m for m in dataset.metrics if m.id == metric_id), None)
    if metric is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Metric not found")
    return metric


def _check_expression(expression: str, db_type: str) -> None:
    """Static check on save (no query); POST .../validate runs it for real."""
    try:
        parse_metric_expression(expression, db_type)
    except QueryError as error:
        _query_error(error)


def _check_metric_unused(db: Session, dataset: Dataset, metric: DatasetMetric) -> None:
    """Saved charts refer to metrics by name: block deleting or renaming a used one."""
    users = [name for name, usage in _chart_usages(db, dataset) if metric.name in usage.metrics]
    if users:
        _blocked(f'Metric "{metric.name}"', users)


def _metric_conflict(name: str) -> str:
    return f'This dataset already has a metric named "{name}"'


@router.post(
    "/{dataset_id}/metrics",
    response_model=DatasetMetricOut,
    status_code=status.HTTP_201_CREATED,
    responses=QUERY_ERROR_RESPONSES,
)
def create_metric(dataset_id: int, payload: MetricIn, db: DbSession) -> DatasetMetric:
    dataset = get_dataset_or_404(db, dataset_id)
    name = payload.name.strip()
    if any(m.name.lower() == name.lower() for m in dataset.metrics):
        raise HTTPException(status.HTTP_409_CONFLICT, _metric_conflict(name))
    _check_expression(payload.expression, dataset.connection.db_type)
    metric = DatasetMetric(
        name=name,
        label=_clean(payload.label),
        expression=payload.expression.strip(),
        description=_clean(payload.description),
        number_format=_clean(payload.number_format),
        is_builtin=False,
    )
    dataset.metrics.append(metric)
    _touch(dataset)
    _commit(db, _metric_conflict(name))
    db.refresh(metric)
    return metric


@router.put(
    "/{dataset_id}/metrics/{metric_id}",
    response_model=DatasetMetricOut,
    responses=QUERY_ERROR_RESPONSES,
)
def update_metric(
    dataset_id: int, metric_id: int, payload: MetricIn, db: DbSession
) -> DatasetMetric:
    dataset = get_dataset_or_404(db, dataset_id)
    metric = _metric_or_404(dataset, metric_id)
    name = payload.name.strip()
    expression = payload.expression.strip()
    if metric.is_builtin and (name != metric.name or expression != metric.expression):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "The built-in count metric's name and expression can't be changed",
        )
    if any(m.name.lower() == name.lower() and m.id != metric.id for m in dataset.metrics):
        raise HTTPException(status.HTTP_409_CONFLICT, _metric_conflict(name))
    if name != metric.name:
        _check_metric_unused(db, dataset, metric)
    _check_expression(expression, dataset.connection.db_type)
    metric.name = name
    metric.label = _clean(payload.label)
    metric.expression = expression
    metric.description = _clean(payload.description)
    metric.number_format = _clean(payload.number_format)
    _touch(dataset)
    _commit(db, _metric_conflict(name))
    db.refresh(metric)
    return metric


@router.delete("/{dataset_id}/metrics/{metric_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_metric(dataset_id: int, metric_id: int, db: DbSession) -> Response:
    dataset = get_dataset_or_404(db, dataset_id)
    metric = _metric_or_404(dataset, metric_id)
    if metric.is_builtin:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "The built-in count metric can't be deleted"
        )
    _check_metric_unused(db, dataset, metric)
    dataset.metrics.remove(metric)
    _touch(dataset)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{dataset_id}/metrics/validate", response_model=MetricValidateOut)
def validate_metric_expression(
    dataset_id: int, payload: MetricValidateIn, db: DbSession
) -> MetricValidateOut:
    """Run SELECT <expression> FROM <dataset> LIMIT 1. Errors are returned, not raised."""
    dataset = get_dataset_or_404(db, dataset_id)
    details = _details(dataset)
    source = source_of(dataset)
    db.close()
    try:
        result = validate_metric(details, source, payload.expression)
    except QueryError as error:
        return MetricValidateOut(ok=False, error=QueryErrorOut(**asdict(error)))
    parsed = parse_metric_expression(payload.expression, details.db_type)
    value = result.rows[0][0] if result.rows else None
    return MetricValidateOut(ok=True, warning=metric_warning(parsed), value=value)
