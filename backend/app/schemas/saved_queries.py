from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class SavedQueryIn(BaseModel):
    """Body for create and update (update replaces all fields)."""

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    connection_id: int | None = None
    sql: str = Field(min_length=1, max_length=100_000)


class SavedQueryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    connection_id: int | None
    connection_name: str | None
    sql: str
    created_at: datetime
    updated_at: datetime
