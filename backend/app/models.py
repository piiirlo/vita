from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Connection(Base):
    """A saved connection to a user's database (not the Vita metadata DB)."""

    __tablename__ = "connections"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    db_type: Mapped[str] = mapped_column(String(20))  # "postgresql" | "mysql"
    host: Mapped[str] = mapped_column(String(255))
    port: Mapped[int]
    database: Mapped[str] = mapped_column(String(255))
    username: Mapped[str] = mapped_column(String(255))
    # NULL means "no password". Never expose this column through the API.
    password_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    extra: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    @property
    def has_password(self) -> bool:
        return self.password_encrypted is not None


class QueryHistory(Base):
    """One row per query run (successful or not)."""

    __tablename__ = "query_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    # SET NULL keeps the history when a connection is deleted.
    connection_id: Mapped[int | None] = mapped_column(
        ForeignKey("connections.id", ondelete="SET NULL"), nullable=True, index=True
    )
    sql: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(10))  # "success" | "error"
    row_count: Mapped[int | None]
    duration_ms: Mapped[int]
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    connection: Mapped[Connection | None] = relationship()

    @property
    def connection_name(self) -> str | None:
        return self.connection.name if self.connection else None


class SavedQuery(Base):
    """A named SQL query saved from SQL Lab."""

    __tablename__ = "saved_queries"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # SET NULL keeps the query when its connection is deleted.
    connection_id: Mapped[int | None] = mapped_column(
        ForeignKey("connections.id", ondelete="SET NULL"), nullable=True, index=True
    )
    sql: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    connection: Mapped[Connection | None] = relationship()

    @property
    def connection_name(self) -> str | None:
        return self.connection.name if self.connection else None


class Dataset(Base):
    """A table or a SQL query on a connection, with column metadata and metrics.

    Charts (Part 6) build their SQL on top of a dataset; see app/datasets/.
    """

    __tablename__ = "datasets"
    __table_args__ = (
        CheckConstraint(
            "(kind = 'table' AND schema IS NOT NULL AND table_name IS NOT NULL AND sql IS NULL)"
            " OR (kind = 'sql' AND sql IS NOT NULL AND schema IS NULL AND table_name IS NULL)",
            name="ck_datasets_kind_fields",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # RESTRICT: a connection can't be deleted while datasets use it.
    connection_id: Mapped[int] = mapped_column(
        ForeignKey("connections.id", ondelete="RESTRICT"), index=True
    )
    kind: Mapped[str] = mapped_column(String(10))  # "table" | "sql"
    schema: Mapped[str | None] = mapped_column(String(255), nullable=True)
    table_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sql: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Name of one of the dataset's temporal columns.
    main_time_column: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    connection: Mapped[Connection] = relationship()
    columns: Mapped[list["DatasetColumn"]] = relationship(
        back_populates="dataset",
        cascade="all, delete-orphan",
        order_by="DatasetColumn.position",
    )
    metrics: Mapped[list["DatasetMetric"]] = relationship(
        back_populates="dataset",
        cascade="all, delete-orphan",
        order_by=lambda: [DatasetMetric.is_builtin.desc(), DatasetMetric.name],
    )

    @property
    def connection_name(self) -> str:
        return self.connection.name


class DatasetColumn(Base):
    __tablename__ = "dataset_columns"
    __table_args__ = (UniqueConstraint("dataset_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(
        ForeignKey("datasets.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    position: Mapped[int] = mapped_column(default=0)  # order in the source
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw_type: Mapped[str] = mapped_column(String(255), default="")
    # What the database reports (refreshed on every sync) ...
    generic_type: Mapped[str] = mapped_column(String(20))
    # ... and the user's override (kept across syncs). Effective type = override or detected.
    generic_type_override: Mapped[str | None] = mapped_column(String(20), nullable=True)
    is_temporal: Mapped[bool] = mapped_column(default=False)
    is_dimension: Mapped[bool] = mapped_column(default=False)
    is_hidden: Mapped[bool] = mapped_column(default=False)
    # The last sync didn't find this column. Kept so its settings return if it does.
    is_missing: Mapped[bool] = mapped_column(default=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    dataset: Mapped[Dataset] = relationship(back_populates="columns")

    @property
    def effective_type(self) -> str:
        return self.generic_type_override or self.generic_type


class DatasetMetric(Base):
    __tablename__ = "dataset_metrics"
    __table_args__ = (UniqueConstraint("dataset_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(
        ForeignKey("datasets.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    expression: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    number_format: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # The built-in "count" metric: can't be deleted, expression is fixed.
    is_builtin: Mapped[bool] = mapped_column(default=False)

    dataset: Mapped[Dataset] = relationship(back_populates="metrics")


class Chart(Base):
    """A saved chart: a dataset, a chart type, and params = {query, display}."""

    __tablename__ = "charts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # RESTRICT: a dataset can't be deleted while charts use it.
    dataset_id: Mapped[int] = mapped_column(
        ForeignKey("datasets.id", ondelete="RESTRICT"), index=True
    )
    viz_type: Mapped[str] = mapped_column(String(20))  # table | big_number | bar | line
    params: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    dataset: Mapped[Dataset] = relationship()

    @property
    def dataset_name(self) -> str:
        return self.dataset.name
