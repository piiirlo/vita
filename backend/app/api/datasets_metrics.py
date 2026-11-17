"""Metrics of the datasets API: /api/datasets/{id}/metrics (create, update, delete) and
metric validation. Included in app.api.datasets.router."""

from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Response, status

from app.api.datasets_common import (
    QUERY_ERROR_RESPONSES,
    DbSession,
    clean,
    commit,
    details_of,
    get_dataset_or_404,
    query_error,
    touch,
)
from app.api.datasets_usage import check_metric_unused
from app.datasets import metric_warning, parse_metric_expression, source_of, validate_metric
from app.models import Dataset, DatasetMetric
from app.query import QueryError
from app.schemas.datasets import DatasetMetricOut, MetricIn, MetricValidateIn, MetricValidateOut
from app.schemas.query import QueryErrorOut

router = APIRouter()


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
        query_error(error)


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
        label=clean(payload.label),
        expression=payload.expression.strip(),
        description=clean(payload.description),
        number_format=clean(payload.number_format),
        is_builtin=False,
    )
    dataset.metrics.append(metric)
    touch(dataset)
    commit(db, _metric_conflict(name))
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
        check_metric_unused(db, dataset, metric)
    _check_expression(expression, dataset.connection.db_type)
    metric.name = name
    metric.label = clean(payload.label)
    metric.expression = expression
    metric.description = clean(payload.description)
    metric.number_format = clean(payload.number_format)
    touch(dataset)
    commit(db, _metric_conflict(name))
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
    check_metric_unused(db, dataset, metric)
    dataset.metrics.remove(metric)
    touch(dataset)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{dataset_id}/metrics/validate", response_model=MetricValidateOut)
def validate_metric_expression(
    dataset_id: int, payload: MetricValidateIn, db: DbSession
) -> MetricValidateOut:
    """Run SELECT <expression> FROM <dataset> LIMIT 1. Errors are returned, not raised."""
    dataset = get_dataset_or_404(db, dataset_id)
    details = details_of(dataset)
    source = source_of(dataset)
    db.close()
    try:
        result = validate_metric(details, source, payload.expression)
    except QueryError as error:
        return MetricValidateOut(ok=False, error=QueryErrorOut(**asdict(error)))
    parsed = parse_metric_expression(payload.expression, details.db_type)
    value = result.rows[0][0] if result.rows else None
    return MetricValidateOut(ok=True, warning=metric_warning(parsed), value=value)
