from datetime import datetime
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

DbType = Literal["postgresql", "mysql"]


class ConnectionFields(BaseModel):
    """Connection details without name or password."""

    db_type: DbType
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    database: str = Field(min_length=1, max_length=255)
    username: str = Field(min_length=1, max_length=255)
    extra: dict[str, Any] | None = None


class PasswordChange(BaseModel):
    """Password rules shared by update and test:
    - clear_password=True  -> no password
    - non-empty password   -> use / store this password
    - empty password       -> keep the saved one (if any)
    """

    password: str | None = None
    clear_password: bool = False

    @model_validator(mode="after")
    def _not_both(self) -> Self:
        if self.clear_password and self.password:
            raise ValueError("Send either a password or clear_password, not both")
        return self


class ConnectionCreate(ConnectionFields):
    name: str = Field(min_length=1, max_length=100)
    # Empty or missing means the connection has no password.
    password: str | None = None


class ConnectionUpdate(ConnectionFields, PasswordChange):
    name: str = Field(min_length=1, max_length=100)


class ConnectionTestRequest(ConnectionFields, PasswordChange):
    # With an empty password (and clear_password false), the saved password of
    # this connection is used, so the edit form can test without retyping it.
    connection_id: int | None = None


class ConnectionOut(ConnectionFields):
    """Never add the password (encrypted or not) to this model; only whether one is set."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    has_password: bool
    # "uploads": the built-in Uploads connection (read-only in the UI, can't be edited).
    builtin: str | None = None
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


# ---------- schema diagram ----------


class DiagramColumn(BaseModel):
    name: str
    type: str
    nullable: bool
    primary_key: bool
    foreign_key: bool


class DiagramTable(BaseModel):
    name: str
    type: Literal["table", "view"]
    columns: list[DiagramColumn]


class DiagramForeignKey(BaseModel):
    name: str | None
    table: str
    columns: list[str]
    referred_schema: str
    referred_table: str
    referred_columns: list[str]


class SchemaDiagram(BaseModel):
    schema_name: str
    tables: list[DiagramTable]
    foreign_keys: list[DiagramForeignKey]
    # More tables than the limit: only the first ones (by name) are included.
    truncated: bool = False
