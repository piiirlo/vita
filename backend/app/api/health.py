from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.db import engine

router = APIRouter()


class HealthResponse(BaseModel):
    status: Literal["ok"]
    database: Literal["ok", "error"]
    detail: str | None = None


def check_database() -> str | None:
    """Run a trivial query against the metadata DB. Returns an error message, or None if OK."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        # First line only: driver errors can be long and multi-line.
        return str(exc.orig or exc).strip().splitlines()[0]
    return None


@router.get("/health", response_model=HealthResponse)
def health(
    response: Response,
    db_error: Annotated[str | None, Depends(check_database)],
) -> HealthResponse:
    if db_error is not None:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return HealthResponse(status="ok", database="error", detail=db_error)
    return HealthResponse(status="ok", database="ok")
