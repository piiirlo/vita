from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

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
