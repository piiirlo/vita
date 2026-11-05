from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.connections import get_connection_or_404
from app.db import get_db
from app.models import SavedQuery
from app.schemas.saved_queries import SavedQueryIn, SavedQueryOut

router = APIRouter()

DbSession = Annotated[Session, Depends(get_db)]


def _get_or_404(db: Session, query_id: int) -> SavedQuery:
    saved = db.get(SavedQuery, query_id)
    if saved is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Saved query not found")
    return saved


def _apply(db: Session, saved: SavedQuery, payload: SavedQueryIn) -> None:
    if payload.connection_id is not None:
        get_connection_or_404(db, payload.connection_id)
    saved.name = payload.name.strip()
    saved.description = (payload.description or "").strip() or None
    saved.connection_id = payload.connection_id
    saved.sql = payload.sql


@router.get("", response_model=list[SavedQueryOut])
def list_saved_queries(
    db: DbSession,
    q: Annotated[str | None, Query(max_length=200)] = None,
    connection_id: int | None = None,
) -> list[SavedQuery]:
    stmt = select(SavedQuery).options(selectinload(SavedQuery.connection))
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                SavedQuery.name.ilike(pattern),
                SavedQuery.description.ilike(pattern),
                SavedQuery.sql.ilike(pattern),
            )
        )
    if connection_id is not None:
        stmt = stmt.where(SavedQuery.connection_id == connection_id)
    stmt = stmt.order_by(SavedQuery.updated_at.desc(), SavedQuery.id.desc())
    return list(db.scalars(stmt))


@router.post("", response_model=SavedQueryOut, status_code=status.HTTP_201_CREATED)
def create_saved_query(payload: SavedQueryIn, db: DbSession) -> SavedQuery:
    saved = SavedQuery()
    _apply(db, saved, payload)
    db.add(saved)
    db.commit()
    db.refresh(saved)
    return saved


@router.get("/{query_id}", response_model=SavedQueryOut)
def get_saved_query(query_id: int, db: DbSession) -> SavedQuery:
    return _get_or_404(db, query_id)


@router.put("/{query_id}", response_model=SavedQueryOut)
def update_saved_query(query_id: int, payload: SavedQueryIn, db: DbSession) -> SavedQuery:
    saved = _get_or_404(db, query_id)
    _apply(db, saved, payload)
    db.commit()
    db.refresh(saved)
    return saved


@router.delete("/{query_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_saved_query(query_id: int, db: DbSession) -> Response:
    db.delete(_get_or_404(db, query_id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
