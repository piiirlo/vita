"""Shared helpers of the datasets API (app.api.datasets and its sibling modules): loading a
dataset, the response shape, commits and errors."""

from dataclasses import asdict
from typing import Annotated, NoReturn

from fastapi import Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.connections import saved_connection_details
from app.datasets import source_of, sqllab_sql
from app.datasets.checks import query_warnings
from app.datasets.sql import parse_dataset_query
from app.db import get_db
from app.engines import ConnectionDetails
from app.models import Dataset
from app.query import QueryError
from app.schemas.datasets import DatasetColumnOut, DatasetMetricOut, DatasetOut
from app.schemas.query import QueryErrorOut
from app.uploads.datasets import is_upload_dataset, upload_source

DbSession = Annotated[Session, Depends(get_db)]

QUERY_ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    400: {"description": "The query on the user database failed", "model": QueryErrorOut}
}


def query_error(error: QueryError) -> NoReturn:
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


def details_of(dataset: Dataset) -> ConnectionDetails:
    return saved_connection_details(dataset.connection)


def check_name_free(db: Session, name: str, project_id: int, dataset_id: int | None = None) -> None:
    stmt = select(Dataset.id).where(
        func.lower(Dataset.name) == name.lower(), Dataset.project_id == project_id
    )
    if dataset_id is not None:
        stmt = stmt.where(Dataset.id != dataset_id)
    if db.scalar(stmt) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f'A dataset named "{name}" already exists')


def commit(db: Session, conflict_message: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, conflict_message) from None


def touch(dataset: Dataset) -> None:
    """Column and metric edits don't change the datasets row itself; bump updated_at."""
    dataset.updated_at = func.now()


def clean(text: str | None) -> str | None:
    return (text or "").strip() or None


def _warnings(dataset: Dataset) -> list[str]:
    if dataset.kind != "sql" or not dataset.sql:
        return []
    try:
        return query_warnings(parse_dataset_query(dataset.sql, dataset.connection.db_type))
    except QueryError:
        return []


def list_item_fields(dataset: Dataset) -> dict[str, object]:
    return {
        "id": dataset.id,
        "project_id": dataset.project_id,
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


def dataset_out(db: Session, dataset: Dataset) -> DatasetOut:
    db_type = dataset.connection.db_type
    return DatasetOut(
        **list_item_fields(dataset),
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
