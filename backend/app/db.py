from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    # Fail fast instead of hanging when Postgres is unreachable.
    connect_args={"connect_timeout": 3},
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    """Base class for all ORM models. Alembic autogenerate reads its metadata."""


def get_db() -> Iterator[Session]:
    """FastAPI dependency that yields a DB session and closes it afterwards."""
    with SessionLocal() as session:
        yield session
