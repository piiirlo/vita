import time
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.connections import get_connection_or_404, saved_connection_details
from app.db import get_db
from app.models import QueryHistory
from app.query import DEFAULT_LIMIT, DEFAULT_TIMEOUT_SECONDS, QueryError, run_query
from app.schemas.query import (
    QueryErrorOut,
    QueryHistoryItem,
    QueryHistoryPage,
    QueryRequest,
    QueryResultOut,
)

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]


@router.post(
    "/query",
    response_model=QueryResultOut,
    responses={400: {"description": "The query failed", "model": QueryErrorOut}},
)
def post_query(payload: QueryRequest, db: DbSession) -> QueryResultOut:
    conn = get_connection_or_404(db, payload.connection_id)
    details = saved_connection_details(conn)
    connection_id = conn.id
    db.close()  # don't hold a metadata-DB connection while the query runs

    started_at = datetime.now(UTC)
    started = time.perf_counter()
    entry = QueryHistory(connection_id=connection_id, sql=payload.sql, started_at=started_at)
    try:
        result = run_query(
            details,
            payload.sql,
            limit=payload.limit or DEFAULT_LIMIT,
            timeout_seconds=DEFAULT_TIMEOUT_SECONDS,
        )
    except QueryError as error:
        entry.status = "error"
        entry.error_message = error.message
        entry.duration_ms = round((time.perf_counter() - started) * 1000)
        _log(db, entry)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, QueryErrorOut(**asdict(error)).model_dump()
        ) from None

    entry.status = "success"
    entry.row_count = result.row_count
    entry.duration_ms = result.duration_ms
    _log(db, entry)
    return QueryResultOut.model_validate(asdict(result))


def _log(db: Session, entry: QueryHistory) -> None:
    db.add(entry)
    db.commit()


@router.get("/query-history", response_model=QueryHistoryPage)
def get_query_history(
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    connection_id: int | None = None,
) -> QueryHistoryPage:
    base = select(QueryHistory)
    if connection_id is not None:
        base = base.where(QueryHistory.connection_id == connection_id)

    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.scalars(
        base.options(selectinload(QueryHistory.connection))
        .order_by(QueryHistory.started_at.desc(), QueryHistory.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return QueryHistoryPage(
        items=[QueryHistoryItem.model_validate(r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    )
