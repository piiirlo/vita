from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DbType = Literal["postgresql", "mysql"]


class ConnectionFields(BaseModel):
    """Connection details without name or password."""

    db_type: DbType
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    database: str = Field(min_length=1, max_length=255)
    username: str = Field(min_length=1, max_length=255)
    extra: dict[str, Any] | None = None


class ConnectionCreate(ConnectionFields):
    name: str = Field(min_length=1, max_length=100)
    password: str = ""


class ConnectionUpdate(ConnectionFields):
    name: str = Field(min_length=1, max_length=100)
    # Empty means "keep the existing password".
    password: str = ""


class ConnectionTestRequest(ConnectionFields):
    password: str = ""
    # When editing a saved connection and the password field is left empty,
    # the saved password of this connection is used for the test.
    connection_id: int | None = None


class ConnectionOut(ConnectionFields):
    """Never add the password (encrypted or not) to this model."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    created_at: datetime
    updated_at: datetime


class TestResult(BaseModel):
    ok: bool
    error: str | None = None


class TableInfo(BaseModel):
    name: str
    type: Literal["table", "view"]


class ColumnInfo(BaseModel):
    name: str
    type: str
    nullable: bool
    primary_key: bool
