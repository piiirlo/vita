from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.crypto import decrypt_password
from app.models import Connection

Payload = Callable[..., dict[str, Any]]


# ---------- CRUD ----------


def test_create_list_get_update_delete(client: TestClient, sampledb_payload: Payload) -> None:
    created = client.post("/api/connections", json=sampledb_payload())
    assert created.status_code == 201
    conn = created.json()
    assert conn["name"] == "Sample DB"
    assert conn["host"] == "sampledb"
    assert "created_at" in conn and "updated_at" in conn

    listed = client.get("/api/connections")
    assert listed.status_code == 200
    assert [c["id"] for c in listed.json()] == [conn["id"]]

    fetched = client.get(f"/api/connections/{conn['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["name"] == "Sample DB"

    updated = client.put(
        f"/api/connections/{conn['id']}",
        json=sampledb_payload(name="Renamed", password="", extra={"sslmode": "disable"}),
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"
    assert updated.json()["extra"] == {"sslmode": "disable"}

    deleted = client.delete(f"/api/connections/{conn['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/api/connections/{conn['id']}").status_code == 404
    assert client.get("/api/connections").json() == []


def test_duplicate_name_returns_409(client: TestClient, sampledb_payload: Payload) -> None:
    assert client.post("/api/connections", json=sampledb_payload()).status_code == 201
    response = client.post("/api/connections", json=sampledb_payload())
    assert response.status_code == 409
    assert "already exists" in response.json()["detail"]


def test_missing_connection_returns_404(client: TestClient) -> None:
    assert client.get("/api/connections/999").status_code == 404
    assert client.delete("/api/connections/999").status_code == 404
    assert client.post("/api/connections/999/test").status_code == 404


def test_invalid_db_type_is_rejected(client: TestClient, sampledb_payload: Payload) -> None:
    response = client.post("/api/connections", json=sampledb_payload(db_type="oracle"))
    assert response.status_code == 422


# ---------- passwords ----------


def test_password_never_appears_in_responses(
    client: TestClient, sampledb_payload: Payload, session_factory: sessionmaker[Session]
) -> None:
    secret = "Sup3r-Secret-Value!"
    new_secret = "Another-Secret-2"

    created = client.post("/api/connections", json=sampledb_payload(password=secret))
    conn_id = created.json()["id"]
    responses = [
        created,
        client.get("/api/connections"),
        client.get(f"/api/connections/{conn_id}"),
        client.put(f"/api/connections/{conn_id}", json=sampledb_payload(password=new_secret)),
        client.get(f"/api/connections/{conn_id}"),
        client.post(f"/api/connections/{conn_id}/test"),
    ]

    for response in responses:
        assert secret not in response.text
        assert new_secret not in response.text
        body = response.json()
        for item in body if isinstance(body, list) else [body]:
            assert "password" not in item
            assert "password_encrypted" not in item

    # Stored encrypted, and the update replaced it.
    with session_factory() as session:
        row = session.get(Connection, conn_id)
        assert row is not None
        assert new_secret not in row.password_encrypted
        assert decrypt_password(row.password_encrypted) == new_secret


def test_update_with_empty_password_keeps_existing(
    client: TestClient, sampledb_payload: Payload
) -> None:
    conn_id = client.post("/api/connections", json=sampledb_payload()).json()["id"]

    response = client.put(
        f"/api/connections/{conn_id}", json=sampledb_payload(name="Still works", password="")
    )
    assert response.status_code == 200

    result = client.post(f"/api/connections/{conn_id}/test").json()
    assert result == {"ok": True, "error": None}


# ---------- testing connections ----------


def test_unsaved_connection_test_success(client: TestClient, sampledb_payload: Payload) -> None:
    response = client.post("/api/connections/test", json=sampledb_payload())
    assert response.status_code == 200
    assert response.json() == {"ok": True, "error": None}
    # Testing must not save anything.
    assert client.get("/api/connections").json() == []


def test_wrong_password_gives_clear_error(client: TestClient, sampledb_payload: Payload) -> None:
    result = client.post("/api/connections/test", json=sampledb_payload(password="nope")).json()
    assert result["ok"] is False
    assert "Wrong username or password" in result["error"]


def test_unknown_host_gives_clear_error(client: TestClient, sampledb_payload: Payload) -> None:
    result = client.post(
        "/api/connections/test", json=sampledb_payload(host="does-not-exist.invalid")
    ).json()
    assert result["ok"] is False
    assert "could not be found" in result["error"]


def test_unknown_database_gives_clear_error(
    client: TestClient, sampledb_payload: Payload
) -> None:
    result = client.post(
        "/api/connections/test", json=sampledb_payload(database="no_such_db")
    ).json()
    assert result["ok"] is False
    assert 'Database "no_such_db" does not exist' in result["error"]


def test_closed_port_gives_clear_error(client: TestClient, sampledb_payload: Payload) -> None:
    result = client.post("/api/connections/test", json=sampledb_payload(port=5999)).json()
    assert result["ok"] is False
    assert "connection refused" in result["error"]


def test_saved_connection_test_failure(client: TestClient, sampledb_payload: Payload) -> None:
    conn_id = client.post(
        "/api/connections", json=sampledb_payload(password="wrong")
    ).json()["id"]
    result = client.post(f"/api/connections/{conn_id}/test").json()
    assert result["ok"] is False
    assert "Wrong username or password" in result["error"]


def test_unsaved_test_reuses_saved_password_when_empty(
    client: TestClient, sampledb_payload: Payload
) -> None:
    conn_id = client.post("/api/connections", json=sampledb_payload()).json()["id"]
    body = sampledb_payload(password="", connection_id=conn_id)
    del body["name"]
    assert client.post("/api/connections/test", json=body).json()["ok"] is True


# ---------- browsing the sampledb ----------


def _create_sampledb(client: TestClient, sampledb_payload: Payload) -> int:
    response = client.post("/api/connections", json=sampledb_payload())
    assert response.status_code == 201
    conn_id: int = response.json()["id"]
    return conn_id


def test_browse_schemas(client: TestClient, sampledb_payload: Payload) -> None:
    conn_id = _create_sampledb(client, sampledb_payload)
    schemas = client.get(f"/api/connections/{conn_id}/schemas").json()
    assert "sales" in schemas
    assert "information_schema" not in schemas
    assert "pg_catalog" not in schemas


def test_browse_tables(client: TestClient, sampledb_payload: Payload) -> None:
    conn_id = _create_sampledb(client, sampledb_payload)
    tables = client.get(f"/api/connections/{conn_id}/schemas/sales/tables").json()
    assert {"name": "orders", "type": "table"} in tables
    assert {"name": "customers", "type": "table"} in tables
    assert {"name": "order_totals", "type": "view"} in tables


def test_browse_columns_of_orders(client: TestClient, sampledb_payload: Payload) -> None:
    conn_id = _create_sampledb(client, sampledb_payload)
    response = client.get(f"/api/connections/{conn_id}/schemas/sales/tables/orders/columns")
    assert response.status_code == 200
    columns = {c["name"]: c for c in response.json()}

    assert list(columns) == ["id", "customer_id", "order_date", "status", "channel"]
    assert columns["id"]["primary_key"] is True
    assert columns["order_date"]["type"] == "DATE"
    assert columns["order_date"]["nullable"] is False
    assert columns["status"]["primary_key"] is False


def test_browse_unknown_schema_and_table_return_404(
    client: TestClient, sampledb_payload: Payload
) -> None:
    conn_id = _create_sampledb(client, sampledb_payload)
    assert client.get(f"/api/connections/{conn_id}/schemas/nope/tables").status_code == 404
    assert (
        client.get(f"/api/connections/{conn_id}/schemas/sales/tables/nope/columns").status_code
        == 404
    )


def test_browse_with_wrong_password_returns_clear_400(
    client: TestClient, sampledb_payload: Payload
) -> None:
    conn_id = client.post(
        "/api/connections", json=sampledb_payload(password="wrong")
    ).json()["id"]
    response = client.get(f"/api/connections/{conn_id}/schemas")
    assert response.status_code == 400
    assert "Wrong username or password" in response.json()["detail"]
