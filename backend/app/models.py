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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    dataset: Mapped[Dataset] = relationship()

    @property
    def dataset_name(self) -> str:
        return self.dataset.name


class Dashboard(Base):
    """A dashboard: a grid layout of chart and text tiles (see app/schemas/dashboards.py)."""

    __tablename__ = "dashboards"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # List of tiles; the source of truth for what the dashboard shows.
    layout: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    refresh_interval: Mapped[str] = mapped_column(String(10), default="off")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    chart_links: Mapped[list["DashboardChart"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True
    )


class DashboardChart(Base):
    """Which charts a dashboard's layout uses; rebuilt from the layout on every save.
    RESTRICT: a chart can't be deleted (even directly in the DB) while a dashboard uses it."""

    __tablename__ = "dashboard_charts"

    dashboard_id: Mapped[int] = mapped_column(
        ForeignKey("dashboards.id", ondelete="CASCADE"), primary_key=True
    )
    chart_id: Mapped[int] = mapped_column(
        ForeignKey("charts.id", ondelete="RESTRICT"), primary_key=True, index=True
    )


class User(Base):
    """A Vita user (single admin for now). The password is stored as an argon2 hash."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(100), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class UserSession(Base):
    """A login session. Only a SHA-256 hash of the cookie token is stored."""

    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    user: Mapped[User] = relationship()


class LoginFailure(Base):
    """Failed logins per (username, client address), to slow down password guessing.
    Stored in the DB so it works across several backend workers."""

    __tablename__ = "login_failures"

    key: Mapped[str] = mapped_column(String(400), primary_key=True)
    count: Mapped[int] = mapped_column(default=0)
    first_failed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
