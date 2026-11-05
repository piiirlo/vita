import os
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db import get_db
from app.main import app

BACKEND_DIR = Path(__file__).resolve().parent.parent
TEST_DB_NAME = "vita_test"


@pytest.fixture(scope="session")
def test_engine() -> Iterator[Engine]:
    """A separate `vita_test` database next to the real one, migrated to head."""
    base_url = make_url(settings.database_url)

    admin = create_engine(base_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        exists = conn.scalar(
            text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": TEST_DB_NAME}
        )
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{TEST_DB_NAME}"'))
    admin.dispose()

    test_url = base_url.set(database=TEST_DB_NAME)
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option(
        "sqlalchemy.url", test_url.render_as_string(hide_password=False).replace("%", "%%")
    )
    command.upgrade(cfg, "head")

    engine = create_engine(test_url)
    yield engine
    engine.dispose()


@pytest.fixture
def session_factory(test_engine: Engine) -> sessionmaker[Session]:
    with test_engine.begin() as conn:
        conn.execute(text("TRUNCATE charts, dataset_metrics, dataset_columns, datasets, saved_queries, query_history, connections RESTART IDENTITY"))
    return sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)


@pytest.fixture
def client(session_factory: sessionmaker[Session]) -> Iterator[TestClient]:
    def override_get_db() -> Iterator[Session]:
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def sampledb_payload() -> Callable[..., dict[str, Any]]:
    """Connection payload for the seeded demo DB (the `sampledb` compose service)."""

    def make(**overrides: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": "Sample DB",
            "db_type": "postgresql",
            "host": "sampledb",
            "port": 5432,
            "database": os.environ["SAMPLEDB_DB"],
            "username": os.environ["SAMPLEDB_USER"],
            "password": os.environ["SAMPLEDB_PASSWORD"],
        }
        payload.update(overrides)
        return payload

    return make
