"""Create SQLAlchemy engines for user databases.

Shared by connection testing/browsing (Part 2) and the query engine (Part 3).
Engines use NullPool: every use opens a fresh DB connection, nothing is cached.
"""

from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import URL
from sqlalchemy.pool import NullPool

from app.crypto import decrypt_password
from app.models import Connection

DbType = Literal["postgresql", "mysql"]

DRIVERS: dict[str, str] = {
    "postgresql": "postgresql+psycopg",
    "mysql": "mysql+pymysql",
}

DEFAULT_PORTS: dict[str, int] = {"postgresql": 5432, "mysql": 3306}

CONNECT_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class ConnectionDetails:
    """Everything needed to connect, with the password in plain text. Never serialize this."""

    db_type: str
    host: str
    port: int
    database: str
    username: str
    password: str
    extra: dict[str, Any] | None = None


def details_from_connection(conn: Connection) -> ConnectionDetails:
    return ConnectionDetails(
        db_type=conn.db_type,
        host=conn.host,
        port=conn.port,
        database=conn.database,
        username=conn.username,
        password=decrypt_password(conn.password_encrypted),
        extra=conn.extra,
    )


def build_url(details: ConnectionDetails) -> URL:
    try:
        driver = DRIVERS[details.db_type]
    except KeyError:
        raise ValueError(f"Unsupported database type: {details.db_type}") from None
    return URL.create(
        drivername=driver,
        username=details.username,
        password=details.password or None,
        host=details.host,
        port=details.port,
        database=details.database,
    )


def create_engine_for(details: ConnectionDetails) -> Engine:
    """Engine for a user database. `extra` options are passed to the DB driver
    (e.g. {"sslmode": "require"}); our connect timeout always wins."""
    connect_args: dict[str, Any] = {
        **(details.extra or {}),
        "connect_timeout": CONNECT_TIMEOUT_SECONDS,
    }
    return create_engine(build_url(details), poolclass=NullPool, connect_args=connect_args)


def check_connection(details: ConnectionDetails) -> None:
    """Open a connection and run SELECT 1. Raises on any failure."""
    engine = create_engine_for(details)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    finally:
        engine.dispose()
