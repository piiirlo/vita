"""Shared fixtures and helpers of the chart tests (test_charts.py, test_dashboard_filters.py):
sampledb, a connection to it, the "Order lines" and "Orders" datasets, and saving column
settings. Import the fixtures into a test module to use them."""

import os
from collections.abc import Callable, Iterator
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import URL

LINES_SQL = """
SELECT o.id AS order_id, o.order_date, o.status, o.channel, o.customer_id,
       NULLIF(o.channel, 'store') AS web_or_mobile,
       oi.quantity, oi.unit_price, oi.quantity * oi.unit_price AS line_total
FROM sales.orders o
JOIN sales.order_items oi ON oi.order_id = o.id
"""


@pytest.fixture(scope="module")
def sampledb() -> Iterator[Engine]:
    url = URL.create(
        "postgresql+psycopg",
        username=os.environ["SAMPLEDB_USER"],
        password=os.environ["SAMPLEDB_PASSWORD"],
        host="sampledb",
        port=5432,
        database=os.environ["SAMPLEDB_DB"],
    )
    engine = create_engine(url)
    yield engine
    engine.dispose()


def normalize(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, date):
        return value.isoformat()
    return value


@pytest.fixture
def expect(sampledb: Engine) -> Callable[[str], list[list[Any]]]:
    """Run hand-written SQL on sampledb; `lines` is available as a CTE."""

    def run(sql: str) -> list[list[Any]]:
        with sampledb.connect() as conn:
            rows = conn.execute(text(f"WITH lines AS ({LINES_SQL}) {sql}")).all()
        return [[normalize(v) for v in row] for row in rows]

    return run


@pytest.fixture
def connection_id(client: TestClient, sampledb_payload: Callable[..., dict[str, Any]]) -> int:
    response = client.post("/api/connections", json=sampledb_payload())
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


@pytest.fixture
def lines(client: TestClient, connection_id: int) -> int:
    """A SQL dataset (so the FROM clause is a subquery) with a saved revenue metric."""
    response = client.post(
        "/api/datasets",
        json={
            "name": "Order lines",
            "connection_id": connection_id,
            "kind": "sql",
            "sql": LINES_SQL,
        },
    )
    assert response.status_code == 201, response.text
    dataset_id = int(response.json()["id"])
    metric = client.post(
        f"/api/datasets/{dataset_id}/metrics",
        json={"name": "revenue", "label": "Revenue", "expression": "SUM(line_total)"},
    )
    assert metric.status_code == 201, metric.text
    return dataset_id


@pytest.fixture
def orders(client: TestClient, connection_id: int) -> int:
    response = client.post(
        "/api/datasets",
        json={"name": "Orders", "connection_id": connection_id, "kind": "table",
              "schema": "sales", "table_name": "orders"},
    )  # fmt: skip
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def column_settings(dataset: dict[str, Any], name: str, **changes: Any) -> dict[str, Any]:
    col = next(c for c in dataset["columns"] if c["name"] == name)
    keys = (
        "id",
        "label",
        "generic_type_override",
        "is_temporal",
        "is_dimension",
        "is_hidden",
        "description",
    )
    return {**{k: col[k] for k in keys}, **changes}


def save_columns(
    client: TestClient, dataset_id: int, *settings: dict[str, Any], **extra: Any
) -> Any:
    dataset = client.get(f"/api/datasets/{dataset_id}").json()
    return client.put(f"/api/datasets/{dataset_id}", json={
        "name": dataset["name"], "description": None, "main_time_column": dataset["main_time_column"],
        "columns": list(settings), **extra})  # fmt: skip
