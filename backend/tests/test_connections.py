from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection as SAConnection
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from app.crypto import decrypt_password
from app.engines import ConnectionDetails, create_engine_for
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


def _stored_password(session_factory: sessionmaker[Session], conn_id: int) -> str | None:
    with session_factory() as session:
        row = session.get(Connection, conn_id)
        assert row is not None
        return row.password_encrypted


def test_update_with_empty_password_keeps_existing(
    client: TestClient, sampledb_payload: Payload, session_factory: sessionmaker[Session]
) -> None:
    created = client.post("/api/connections", json=sampledb_payload()).json()
    assert created["has_password"] is True
    conn_id = created["id"]
    stored_before = _stored_password(session_factory, conn_id)

    for empty in ("", None):
        response = client.put(
            f"/api/connections/{conn_id}", json=sampledb_payload(name="Still works", password=empty)
        )
        assert response.status_code == 200
        assert response.json()["has_password"] is True

    assert _stored_password(session_factory, conn_id) == stored_before
    result = client.post(f"/api/connections/{conn_id}/test").json()
    assert result == {"ok": True, "error": None}


def test_create_without_password(
    client: TestClient, sampledb_payload: Payload, session_factory: sessionmaker[Session]
) -> None:
    for i, empty in enumerate(("", None)):
        response = client.post(
            "/api/connections", json=sampledb_payload(name=f"No pw {i}", password=empty)
        )
        assert response.status_code == 201
        assert response.json()["has_password"] is False
        # Stored as NULL, not as an encrypted empty string.
        assert _stored_password(session_factory, response.json()["id"]) is None

    # Omitting the field entirely also means no password.
    body = sampledb_payload(name="No pw field")
    del body["password"]
    response = client.post("/api/connections", json=body)
    assert response.json()["has_password"] is False

    # Such a connection can be tested and fails cleanly (sampledb requires a password).
    result = client.post(f"/api/connections/{response.json()['id']}/test").json()
    assert result["ok"] is False
    assert "password" in result["error"].lower()


def test_update_clear_password_removes_saved_password(
    client: TestClient, sampledb_payload: Payload, session_factory: sessionmaker[Session]
) -> None:
    conn_id = client.post("/api/connections", json=sampledb_payload()).json()["id"]
    assert _stored_password(session_factory, conn_id) is not None

    response = client.put(
        f"/api/connections/{conn_id}", json=sampledb_payload(password="", clear_password=True)
    )
    assert response.status_code == 200
    assert response.json()["has_password"] is False
    assert _stored_password(session_factory, conn_id) is None


def test_clear_password_and_new_password_together_is_rejected(
    client: TestClient, sampledb_payload: Payload
) -> None:
    conn_id = client.post("/api/connections", json=sampledb_payload()).json()["id"]
    response = client.put(
        f"/api/connections/{conn_id}", json=sampledb_payload(password="x", clear_password=True)
    )
    assert response.status_code == 422


def test_unsaved_test_password_rules(client: TestClient, sampledb_payload: Payload) -> None:
    """Test endpoint follows the save rules: keep saved / none / new value."""
    conn_id = client.post("/api/connections", json=sampledb_payload()).json()["id"]

    def run(**overrides: Any) -> dict[str, Any]:
        body = sampledb_payload(connection_id=conn_id, **overrides)
        del body["name"]
        result: dict[str, Any] = client.post("/api/connections/test", json=body).json()
        return result

    assert run(password="")["ok"] is True  # keep saved
    assert run(password="wrong")["ok"] is False  # new value is used
    no_pw = run(password="", clear_password=True)  # none, saved one ignored
    assert no_pw["ok"] is False
    assert "password" in no_pw["error"].lower()


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


RESTRICTED_USER = "vita_restricted"
RESTRICTED_PASSWORD = "restricted-pw-1"


@pytest.fixture
def restricted_sampledb(sampledb_payload: Payload) -> Iterator[dict[str, Any]]:
    """A sampledb user that can read sales.* but not pg_collation, like the
    public RNAcentral server. The SQLAlchemy Postgres inspector needs pg_collation."""
    admin = create_engine_for(
        ConnectionDetails(
            **{k: v for k, v in sampledb_payload().items() if k != "name"}  # type: ignore[arg-type]
        )
    ).execution_options(isolation_level="AUTOCOMMIT")

    def cleanup(conn: SAConnection) -> None:
        conn.execute(text("GRANT SELECT ON pg_catalog.pg_collation TO PUBLIC"))
        conn.execute(
            text(
                f"DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = '{RESTRICTED_USER}') "
                f"THEN REVOKE ALL ON ALL TABLES IN SCHEMA sales FROM {RESTRICTED_USER}; "
                f"REVOKE ALL ON SCHEMA sales FROM {RESTRICTED_USER}; "
                f"DROP ROLE {RESTRICTED_USER}; END IF; END $$"
            )
        )

    with admin.connect() as conn:
        cleanup(conn)
        conn.execute(text(f"CREATE ROLE {RESTRICTED_USER} LOGIN PASSWORD '{RESTRICTED_PASSWORD}'"))
        conn.execute(text(f"GRANT USAGE ON SCHEMA sales TO {RESTRICTED_USER}"))
        conn.execute(text(f"GRANT SELECT ON ALL TABLES IN SCHEMA sales TO {RESTRICTED_USER}"))
        conn.execute(text("REVOKE SELECT ON pg_catalog.pg_collation FROM PUBLIC"))
    try:
        yield sampledb_payload(
            name="Restricted", username=RESTRICTED_USER, password=RESTRICTED_PASSWORD
        )
    finally:
        with admin.connect() as conn:
            cleanup(conn)
        admin.dispose()


def test_browse_columns_without_access_to_system_catalogs(
    client: TestClient, restricted_sampledb: dict[str, Any]
) -> None:
    conn_id = client.post("/api/connections", json=restricted_sampledb).json()["id"]
    response = client.get(f"/api/connections/{conn_id}/schemas/sales/tables/orders/columns")
    assert response.status_code == 200, response.text
    columns = {c["name"]: c for c in response.json()}

    assert list(columns) == ["id", "customer_id", "order_date", "status", "channel"]
    assert columns["id"]["primary_key"] is True
    assert columns["id"]["type"] == "INTEGER"
    assert columns["order_date"]["type"] == "DATE"
    assert columns["order_date"]["nullable"] is False

    # Same fallback for products, which has a NUMERIC(10, 2) column.
    products = client.get(
        f"/api/connections/{conn_id}/schemas/sales/tables/products/columns"
    ).json()
    assert {"name": "unit_price", "type": "NUMERIC(10, 2)", "nullable": False,
            "primary_key": False} in products

    missing = client.get(f"/api/connections/{conn_id}/schemas/sales/tables/nope/columns")
    assert missing.status_code == 404


def test_browse_unknown_schema_and_table_return_404(
    client: TestClient, sampledb_payload: Payload
) -> None:
    conn_id = _create_sampledb(client, sampledb_payload)
    assert client.get(f"/api/connections/{conn_id}/schemas/nope/tables").status_code == 404
    assert (
        client.get(f"/api/connections/{conn_id}/schemas/sales/tables/nope/columns").status_code
        == 404
    )


def test_unknown_extra_option_gives_clear_400(
    client: TestClient, sampledb_payload: Payload
) -> None:
    conn_id = client.post(
        "/api/connections", json=sampledb_payload(extra={"bogus_option": "1"})
    ).json()["id"]
    response = client.get(f"/api/connections/{conn_id}/schemas")
    assert response.status_code == 400
    assert 'Unknown extra option "bogus_option"' in response.json()["detail"]


def test_valid_extra_option_is_passed_to_driver(
    client: TestClient, sampledb_payload: Payload
) -> None:
    ok = client.post("/api/connections/test", json=sampledb_payload(extra={"sslmode": "disable"}))
    assert ok.json()["ok"] is True
    # sslmode=require fails because sampledb has no SSL, proving the option reached libpq.
    fail = client.post("/api/connections/test", json=sampledb_payload(extra={"sslmode": "require"}))
    assert fail.json()["ok"] is False


def test_browse_with_wrong_password_returns_clear_400(
    client: TestClient, sampledb_payload: Payload
) -> None:
    conn_id = client.post(
        "/api/connections", json=sampledb_payload(password="wrong")
    ).json()["id"]
    response = client.get(f"/api/connections/{conn_id}/schemas")
    assert response.status_code == 400
    assert "Wrong username or password" in response.json()["detail"]
