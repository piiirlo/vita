"""Datasets API: /api/datasets.

Anything that talks to the user database (sync, preview, metric validation) goes through
app.datasets, which uses run_query. The metadata-DB session is closed while those run.
"""

from dataclasses import asdict
from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.connections import get_connection_or_404, saved_connection_details
from app.datasets import (
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
    validate_metric,
)
from app.charts.usage import GROUP, TIME, QueryUsage, query_usage, used_by_message
from app.datasets.checks import query_warnings
from app.datasets.sql import parse_dataset_query
from app.db import get_db
from app.engines import ConnectionDetails
from app.models import Chart, Dataset, DatasetColumn, DatasetMetric
from app.query import QueryError
from app.schemas.datasets import (
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
)
from app.schemas.charts import ChartParams
from app.schemas.query import QueryErrorOut

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]

COUNT_METRIC = {"name": "count", "label": "Count", "expression": "COUNT(*)"}

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
    dataset.updated_at = func.now()  # type: ignore[assignment]


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
    }


def _out(dataset: Dataset) -> DatasetOut:
    db_type = dataset.connection.db_type
    return DatasetOut(
        **_list_item_fields(dataset),  # type: ignore[arg-type]
        db_type=db_type,
        sql=dataset.sql,
        main_time_column=dataset.main_time_column,
        columns=[DatasetColumnOut.model_validate(c) for c in dataset.columns],
        metrics=[DatasetMetricOut.model_validate(m) for m in dataset.metrics],
        warnings=_warnings(dataset),
        sqllab_sql=sqllab_sql(source_of(dataset), db_type),
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
    return [DatasetListItem(**_list_item_fields(d)) for d in db.scalars(stmt)]  # type: ignore[arg-type]


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

    dataset = Dataset(
        name=name,
        description=_clean(payload.description),
        connection_id=payload.connection_id,
        kind=source.kind,
        schema=source.schema,
        table_name=source.table_name,
        sql=source.sql,
    )
    merge_columns(dataset, detected)
    dataset.metrics.append(DatasetMetric(**COUNT_METRIC, is_builtin=True))
    db.add(dataset)
    _commit(db, f'A dataset named "{name}" already exists')
    return _out(get_dataset_or_404(db, dataset.id))


@router.get("/{dataset_id}", response_model=DatasetOut)
def get_dataset(dataset_id: int, db: DbSession) -> DatasetOut:
    return _out(get_dataset_or_404(db, dataset_id))


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
        col = by_id.get(settings.id)
        if col is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Column {settings.id} is not part of this dataset"
            )
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
        col.is_dimension = settings.is_dimension
        col.is_hidden = settings.is_hidden
        col.description = _clean(settings.description)

    for column_id in payload.delete_column_ids:
        col = by_id.get(column_id)
        if col is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Column {column_id} is not part of this dataset"
            )
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
    return _out(get_dataset_or_404(db, dataset_id))


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, db: DbSession) -> Response:
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
    db.delete(dataset)
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

    dataset = get_dataset_or_404(db, dataset_id)
    result = merge_columns(dataset, detected)
    _touch(dataset)
    db.commit()
    db.expire_all()
    return SyncOut(dataset=_out(get_dataset_or_404(db, dataset_id)), summary=SyncSummary(**asdict(result)))


@router.get("/{dataset_id}/preview", response_model=PreviewOut, responses=QUERY_ERROR_RESPONSES)
def preview_dataset(dataset_id: int, db: DbSession) -> PreviewOut:
    """The first 100 rows: SELECT * FROM <dataset>."""
    dataset = get_dataset_or_404(db, dataset_id)
    details = _details(dataset)
    source = source_of(dataset)
    db.close()
    try:
        sql = select_sql(source, details.db_type)
        result = preview(details, source)
    except QueryError as error:
        _query_error(error)
    return PreviewOut(**asdict(result), sql=sql)


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
def update_metric(dataset_id: int, metric_id: int, payload: MetricIn, db: DbSession) -> DatasetMetric:
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
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The built-in count metric can't be deleted")
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

