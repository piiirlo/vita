from datetime import datetime
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.query import QueryErrorOut, QueryResultOut

GenericType = Literal["number", "string", "datetime", "date", "boolean", "other"]
DatasetKind = Literal["table", "sql"]


# ---------- columns ----------


class DatasetColumnOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    position: int
    label: str | None
    raw_type: str
    generic_type: GenericType  # what the database reports
    generic_type_override: GenericType | None
    effective_type: GenericType  # override or detected
    is_temporal: bool
    is_dimension: bool
    is_hidden: bool
    is_missing: bool
    description: str | None


class ColumnSettings(BaseModel):
    """The user-editable settings of one column (matched by id)."""

    id: int
    label: str | None = Field(default=None, max_length=255)
    generic_type_override: GenericType | None = None
    is_temporal: bool
    is_dimension: bool
    is_hidden: bool
    description: str | None = None


# ---------- metrics ----------


class DatasetMetricOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    label: str | None
    expression: str
    description: str | None
    number_format: str | None
    is_builtin: bool


class MetricIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    label: str | None = Field(default=None, max_length=255)
    expression: str = Field(min_length=1, max_length=10_000)
    description: str | None = None
    number_format: str | None = Field(default=None, max_length=50)


class MetricValidateIn(BaseModel):
    expression: str = Field(max_length=10_000)


class MetricValidateOut(BaseModel):
    ok: bool
    error: QueryErrorOut | None = None
    warning: str | None = None  # e.g. no aggregate function
    value: Any = None  # the expression's value on the dataset, when ok


# ---------- datasets ----------


class DatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    connection_id: int
    kind: DatasetKind
    schema_: str | None = Field(default=None, alias="schema", max_length=255)
    table_name: str | None = Field(default=None, max_length=255)
    sql: str | None = Field(default=None, max_length=100_000)

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="after")
    def _fields_for_kind(self) -> Self:
        if self.kind == "table":
            if not (self.schema_ and self.table_name):
                raise ValueError("A table dataset needs a schema and a table_name")
            if self.sql:
                raise ValueError("A table dataset can't have SQL")
        else:
            if not (self.sql and self.sql.strip()):
                raise ValueError("A SQL dataset needs sql")
            if self.schema_ or self.table_name:
                raise ValueError("A SQL dataset can't have a schema or table_name")
        return self


class DatasetUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    # Only for kind="sql"; changing it re-syncs the columns.
    sql: str | None = Field(default=None, max_length=100_000)
    main_time_column: str | None = None
    # Settings for some or all columns; columns not listed are left alone.
    columns: list[ColumnSettings] | None = None
    # Remove these columns; only allowed for columns marked is_missing.
    delete_column_ids: list[int] = Field(default_factory=list)


class DatasetListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    name: str
    description: str | None
    connection_id: int
    connection_name: str
    kind: DatasetKind
    schema_: str | None = Field(alias="schema", serialization_alias="schema")
    table_name: str | None
    column_count: int
    metric_count: int
    created_at: datetime
    updated_at: datetime


class DatasetOut(DatasetListItem):
    db_type: str
    sql: str | None
    main_time_column: str | None
    columns: list[DatasetColumnOut]
    metrics: list[DatasetMetricOut]
    warnings: list[str]  # e.g. the SQL ends with ORDER BY / LIMIT
    sqllab_sql: str  # what "Open in SQL Lab" puts in the editor


class SyncSummary(BaseModel):
    added: list[str]
    removed: list[str]
    restored: list[str]
    type_changed: list[str]


class SyncOut(BaseModel):
    dataset: DatasetOut
    summary: SyncSummary


class PreviewOut(QueryResultOut):
    sql: str
