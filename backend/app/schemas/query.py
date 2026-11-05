from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.query import MAX_LIMIT


class QueryRequest(BaseModel):
    connection_id: int
    sql: str = Field(min_length=1, max_length=100_000)
    limit: int | None = Field(default=None, ge=1, le=MAX_LIMIT)


class ResultColumnOut(BaseModel):
    name: str
    type: Literal["number", "string", "datetime", "date", "boolean", "other"]
    db_type: str


class QueryResultOut(BaseModel):
    columns: list[ResultColumnOut]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    duration_ms: int


class QueryErrorOut(BaseModel):
    """Body of `detail` in a 400 response from POST /api/query."""

    kind: str
    message: str
    line: int | None = None
    column: int | None = None


class QueryHistoryItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    connection_id: int | None
    connection_name: str | None
    sql: str
    status: Literal["success", "error"]
    row_count: int | None
    duration_ms: int
    error_message: str | None
    started_at: datetime


class QueryHistoryPage(BaseModel):
    items: list[QueryHistoryItem]
    total: int
    limit: int
    offset: int
