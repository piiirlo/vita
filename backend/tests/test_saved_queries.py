from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

Payload = Callable[..., dict[str, Any]]


@pytest.fixture
def conn_id(client: TestClient, sampledb_payload: Payload) -> int:
    connection_id: int = client.post("/api/connections", json=sampledb_payload()).json()["id"]
    return connection_id


def make(client: TestClient, **fields: Any) -> dict[str, Any]:
    body = {"name": "Orders per month", "sql": "SELECT 1", **fields}
    response = client.post("/api/saved-queries", json=body)
    assert response.status_code == 201, response.text
    saved: dict[str, Any] = response.json()
    return saved


def test_create_get_update_delete(client: TestClient, conn_id: int) -> None:
    saved = make(
        client,
        name="  Revenue by channel ",
        description="For the weekly report",
        connection_id=conn_id,
        sql="SELECT channel, sum(total) FROM sales.order_totals GROUP BY 1",
    )
    assert saved["name"] == "Revenue by channel"  # trimmed
    assert saved["connection_name"] == "Sample DB"
    assert saved["created_at"] and saved["updated_at"]

    fetched = client.get(f"/api/saved-queries/{saved['id']}").json()
    assert fetched == saved

    updated = client.put(
        f"/api/saved-queries/{saved['id']}",
        json={"name": "Revenue", "description": "", "connection_id": conn_id, "sql": "SELECT 2"},
    )
    assert updated.status_code == 200
    body = updated.json()
    assert (body["name"], body["description"], body["sql"]) == ("Revenue", None, "SELECT 2")
    assert body["updated_at"] >= saved["updated_at"]

    assert client.delete(f"/api/saved-queries/{saved['id']}").status_code == 204
    assert client.get(f"/api/saved-queries/{saved['id']}").status_code == 404


def test_list_newest_first_with_search_and_filter(client: TestClient, conn_id: int) -> None:
    make(client, name="Customers by country", sql="SELECT country FROM sales.customers")
    make(client, name="Daily revenue", description="sum of totals", connection_id=conn_id)
    make(client, name="Top products", sql="SELECT * FROM sales.products", connection_id=conn_id)

    names = [s["name"] for s in client.get("/api/saved-queries").json()]
    assert names == ["Top products", "Daily revenue", "Customers by country"]

    def search(**params: Any) -> list[str]:
        return [s["name"] for s in client.get("/api/saved-queries", params=params).json()]

    assert search(q="revenue") == ["Daily revenue"]  # name, case-insensitive
    assert search(q="TOTALS") == ["Daily revenue"]  # description
    assert search(q="sales.customers") == ["Customers by country"]  # sql
    assert search(connection_id=conn_id) == ["Top products", "Daily revenue"]
    assert search(q="nothing matches") == []


def test_validation_and_not_found(client: TestClient) -> None:
    assert client.post("/api/saved-queries", json={"name": "", "sql": "SELECT 1"}).status_code == 422
    assert client.post("/api/saved-queries", json={"name": "x", "sql": ""}).status_code == 422
    response = client.post(
        "/api/saved-queries", json={"name": "x", "sql": "SELECT 1", "connection_id": 999}
    )
    assert response.status_code == 404
    assert client.get("/api/saved-queries/999").status_code == 404
    assert client.put(
        "/api/saved-queries/999", json={"name": "x", "sql": "SELECT 1"}
    ).status_code == 404
    assert client.delete("/api/saved-queries/999").status_code == 404


def test_saved_query_survives_connection_delete(client: TestClient, conn_id: int) -> None:
    saved = make(client, connection_id=conn_id)
    client.delete(f"/api/connections/{conn_id}")
    fetched = client.get(f"/api/saved-queries/{saved['id']}").json()
    assert fetched["connection_id"] is None
    assert fetched["connection_name"] is None
    assert fetched["sql"] == saved["sql"]
