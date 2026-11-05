"""Datasets API against the real sampledb (Postgres)."""

import os
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL

QUOTING_SCHEMA = "vita_test_quoting"


@pytest.fixture
def connection_id(client: TestClient, sampledb_payload: Callable[..., dict[str, Any]]) -> int:
    response = client.post("/api/connections", json=sampledb_payload())
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def create(client: TestClient, connection_id: int, **fields: Any) -> Any:
    return client.post("/api/datasets", json={"connection_id": connection_id, **fields})


def create_ok(client: TestClient, connection_id: int, **fields: Any) -> dict[str, Any]:
    response = create(client, connection_id, **fields)
    assert response.status_code == 201, response.text
    data: dict[str, Any] = response.json()
    return data


def orders(client: TestClient, connection_id: int) -> dict[str, Any]:
    return create_ok(
        client, connection_id, name="Orders", kind="table", schema="sales", table_name="orders"
    )


def cols(dataset: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["name"]: c for c in dataset["columns"]}


def settings(column: dict[str, Any], **changes: Any) -> dict[str, Any]:
    keys = ("id", "label", "generic_type_override", "is_temporal", "is_dimension", "is_hidden",
            "description")  # fmt: skip
    return {**{k: column[k] for k in keys}, **changes}


def update(client: TestClient, dataset: dict[str, Any], **changes: Any) -> Any:
    body = {
        "name": dataset["name"],
        "description": dataset["description"],
        "main_time_column": dataset["main_time_column"],
        **changes,
    }
    return client.put(f"/api/datasets/{dataset['id']}", json=body)


# ---------- create / read ----------


def test_create_table_dataset(client: TestClient, connection_id: int) -> None:
    dataset = orders(client, connection_id)
    assert dataset["kind"] == "table"
    assert dataset["connection_name"] == "Sample DB"
    assert [c["name"] for c in dataset["columns"]] == [
        "id", "customer_id", "order_date", "status", "channel",
    ]  # fmt: skip
    by_name = cols(dataset)
    assert by_name["order_date"]["generic_type"] == "date"
    assert by_name["order_date"]["is_temporal"] is True
    assert by_name["id"]["generic_type"] == "number"
    assert by_name["id"]["raw_type"] == "INTEGER"  # declared type from the inspector
    assert by_name["status"]["is_dimension"] is True
    assert dataset["main_time_column"] == "order_date"
    assert dataset["column_count"] == 5
    assert dataset["sqllab_sql"] == 'SELECT * FROM "sales"."orders"'
    assert dataset["warnings"] == []
    [count] = dataset["metrics"]
    assert (count["name"], count["expression"], count["is_builtin"]) == ("count", "COUNT(*)", True)

    fetched = client.get(f"/api/datasets/{dataset['id']}").json()
    assert fetched["columns"] == dataset["columns"]


def test_create_sql_dataset(client: TestClient, connection_id: int) -> None:
    dataset = create_ok(
        client,
        connection_id,
        name="Orders with customers",
        kind="sql",
        sql="""
            SELECT o.id AS order_id, o.order_date, c.name AS customer, c.country
            FROM sales.orders o JOIN sales.customers c ON c.id = o.customer_id;
        """,
    )
    assert dataset["kind"] == "sql"
    assert dataset["schema"] is None
    assert list(cols(dataset)) == ["order_id", "order_date", "customer", "country"]
    assert cols(dataset)["customer"]["generic_type"] == "string"
    assert dataset["main_time_column"] == "order_date"
    assert dataset["sqllab_sql"].strip().startswith("SELECT o.id")
    assert dataset["warnings"] == []


def test_sql_dataset_warns_about_order_by_and_limit(client: TestClient, connection_id: int) -> None:
    dataset = create_ok(
        client, connection_id, name="Top", kind="sql",
        sql="SELECT * FROM sales.orders ORDER BY order_date DESC LIMIT 10",
    )  # fmt: skip
    assert len(dataset["warnings"]) == 2


@pytest.mark.parametrize(
    ("sql", "kind"),
    [
        ("DELETE FROM sales.orders", "read_only"),
        ("SELECT 1; DROP TABLE sales.orders", "multiple_statements"),
        ("WITH d AS (DELETE FROM sales.orders RETURNING *) SELECT * FROM d", "read_only"),
        ("SHOW search_path", "not_allowed"),
        ("SELECT * FROM sales.nope", "not_found"),
        ("SELECT id, id FROM sales.orders", "invalid"),  # duplicate column names
    ],
)
def test_unsafe_or_broken_sql_is_rejected(
    client: TestClient, connection_id: int, sql: str, kind: str
) -> None:
    response = create(client, connection_id, name="Bad", kind="sql", sql=sql)
    assert response.status_code == 400, response.text
    assert response.json()["detail"]["kind"] == kind
    assert client.get("/api/datasets").json() == []  # nothing saved
    # The tables are untouched.
    assert create(client, connection_id, name="Check", kind="table", schema="sales",
                  table_name="orders").status_code == 201  # fmt: skip


def test_missing_table(client: TestClient, connection_id: int) -> None:
    response = create(
        client, connection_id, name="X", kind="table", schema="sales", table_name="nope"
    )
    assert response.status_code == 400
    assert response.json()["detail"]["kind"] == "not_found"


def test_kind_fields_are_validated(client: TestClient, connection_id: int) -> None:
    assert create(client, connection_id, name="X", kind="table", schema="sales").status_code == 422
    assert create(client, connection_id, name="X", kind="sql").status_code == 422
    assert create(client, connection_id, name="X", kind="sql", sql="SELECT 1",
                  table_name="orders").status_code == 422  # fmt: skip
    assert create(client, 999, name="X", kind="sql", sql="SELECT 1").status_code == 404


def test_duplicate_name(client: TestClient, connection_id: int) -> None:
    orders(client, connection_id)
    response = create(client, connection_id, name="orders", kind="sql", sql="SELECT 1 AS x")
    assert response.status_code == 409


def test_list_and_search(client: TestClient, connection_id: int) -> None:
    orders(client, connection_id)
    create_ok(
        client, connection_id, name="Customers", kind="sql", sql="SELECT * FROM sales.customers"
    )
    names = [d["name"] for d in client.get("/api/datasets").json()]
    assert sorted(names) == ["Customers", "Orders"]
    found = client.get("/api/datasets", params={"q": "custom"}).json()
    assert [d["name"] for d in found] == ["Customers"]
    assert found[0]["column_count"] == 6
    assert found[0]["metric_count"] == 1


# ---------- column types without rows ----------


def test_zero_row_query_still_gets_types(client: TestClient, connection_id: int) -> None:
    dataset = create_ok(
        client, connection_id, name="Empty", kind="sql",
        sql="SELECT o.*, 1.5::numeric AS ratio, true AS flag, now() AS ts FROM sales.orders o WHERE false",
    )  # fmt: skip
    types = {name: c["generic_type"] for name, c in cols(dataset).items()}
    assert types == {
        "id": "number", "customer_id": "number", "order_date": "date", "status": "string",
        "channel": "string", "ratio": "number", "flag": "boolean", "ts": "datetime",
    }  # fmt: skip
    assert dataset["main_time_column"] is None  # two temporal columns: no guess


# ---------- update and sync ----------


def test_update_column_settings_and_time_column(client: TestClient, connection_id: int) -> None:
    dataset = orders(client, connection_id)
    by_name = cols(dataset)
    response = update(
        client,
        dataset,
        name="Orders (all)",
        description="  All orders  ",
        main_time_column=None,
        columns=[
            settings(by_name["status"], label="Order status", description="paid, shipped, ..."),
            settings(by_name["customer_id"], generic_type_override="string", is_dimension=True),
            settings(by_name["channel"], is_hidden=True),
        ],
    )
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["name"] == "Orders (all)"
    assert updated["description"] == "All orders"
    assert updated["main_time_column"] is None
    by_name = cols(updated)
    assert by_name["status"]["label"] == "Order status"
    assert by_name["customer_id"]["generic_type"] == "number"
    assert by_name["customer_id"]["effective_type"] == "string"
    assert by_name["channel"]["is_hidden"] is True

    # Main time column must be a temporal column of the dataset.
    assert update(client, updated, main_time_column="status").status_code == 400
    assert update(client, updated, main_time_column="nope").status_code == 400
    assert update(client, updated, main_time_column="order_date").json()["main_time_column"] == (
        "order_date"
    )


def test_sync_keeps_settings_and_handles_added_and_removed_columns(
    client: TestClient, connection_id: int
) -> None:
    dataset = create_ok(
        client, connection_id, name="Sync", kind="sql",
        sql="SELECT id, status, order_date FROM sales.orders",
    )  # fmt: skip
    by_name = cols(dataset)
    dataset = update(
        client, dataset,
        columns=[settings(by_name["status"], label="Status!", is_hidden=True,
                          generic_type_override="other")],
    ).json()  # fmt: skip

    # A plain sync with nothing changed keeps everything.
    synced = client.post(f"/api/datasets/{dataset['id']}/sync").json()
    assert synced["summary"] == {"added": [], "removed": [], "restored": [], "type_changed": []}
    assert cols(synced["dataset"])["status"]["label"] == "Status!"

    # New SQL: status and order_date disappear, channel appears.
    response = update(client, dataset, sql="SELECT id, channel FROM sales.orders")
    assert response.status_code == 200, response.text
    changed = response.json()
    by_name = cols(changed)
    assert by_name["status"]["is_missing"] and by_name["order_date"]["is_missing"]
    assert not by_name["channel"]["is_missing"]
    assert changed["main_time_column"] is None  # its column is gone
    assert changed["column_count"] == 2
    assert [c["name"] for c in changed["columns"]] == ["id", "channel", "status", "order_date"]

    # status comes back with the user's settings.
    back = update(client, changed, sql="SELECT id, status FROM sales.orders").json()
    status = cols(back)["status"]
    assert not status["is_missing"]
    assert (status["label"], status["is_hidden"], status["generic_type_override"]) == (
        "Status!", True, "other",
    )  # fmt: skip
    assert cols(back)["channel"]["is_missing"]

    # Missing columns can be removed; existing ones can't.
    channel, status_id = cols(back)["channel"]["id"], cols(back)["status"]["id"]
    assert update(client, back, delete_column_ids=[status_id]).status_code == 400
    removed = update(client, back, delete_column_ids=[channel]).json()
    assert "channel" not in cols(removed)


def test_update_with_unsafe_sql_changes_nothing(client: TestClient, connection_id: int) -> None:
    dataset = create_ok(client, connection_id, name="S", kind="sql", sql="SELECT 1 AS x")
    response = update(client, dataset, sql="DELETE FROM sales.orders")
    assert response.status_code == 400
    assert response.json()["detail"]["kind"] == "read_only"
    assert client.get(f"/api/datasets/{dataset['id']}").json()["sql"] == "SELECT 1 AS x"


def test_table_dataset_has_no_sql(client: TestClient, connection_id: int) -> None:
    dataset = orders(client, connection_id)
    assert update(client, dataset, sql="SELECT 1").status_code == 400


# ---------- preview ----------


def test_preview(client: TestClient, connection_id: int) -> None:
    dataset = orders(client, connection_id)
    response = client.get(f"/api/datasets/{dataset['id']}/preview")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["row_count"] == 100
    assert data["truncated"] is True
    assert [c["name"] for c in data["columns"]][:3] == ["id", "customer_id", "order_date"]
    assert data["sql"] == 'SELECT * FROM "sales"."orders"'


def test_preview_sql_dataset(client: TestClient, connection_id: int) -> None:
    dataset = create_ok(
        client,
        connection_id,
        name="Few",
        kind="sql",
        sql="SELECT id FROM sales.orders WHERE id <= 3",
    )
    data = client.get(f"/api/datasets/{dataset['id']}/preview").json()
    assert data["rows"] == [[1], [2], [3]]
    assert data["truncated"] is False


# ---------- metrics ----------


def items(client: TestClient, connection_id: int) -> dict[str, Any]:
    return create_ok(
        client, connection_id, name="Items", kind="table", schema="sales", table_name="order_items"
    )


def test_metric_validation(client: TestClient, connection_id: int) -> None:
    dataset = items(client, connection_id)
    url = f"/api/datasets/{dataset['id']}/metrics/validate"

    ok = client.post(url, json={"expression": "SUM(quantity * unit_price)"}).json()
    assert ok["ok"] is True and ok["error"] is None and ok["warning"] is None
    assert float(ok["value"]) > 0

    unknown = client.post(url, json={"expression": "SUM(nope)"}).json()
    assert unknown["ok"] is False
    assert unknown["error"]["kind"] == "not_found"
    assert "nope" in unknown["error"]["message"]

    type_error = client.post(url, json={"expression": "SUM(order_id::text)"}).json()
    assert type_error["ok"] is False

    write = client.post(url, json={"expression": "1; DELETE FROM sales.orders"}).json()
    assert write["ok"] is False and write["error"]["kind"] == "multiple_statements"

    plain = client.post(url, json={"expression": "quantity"}).json()
    assert plain["ok"] is True and plain["warning"]


def test_metric_crud(client: TestClient, connection_id: int) -> None:
    dataset = items(client, connection_id)
    base = f"/api/datasets/{dataset['id']}/metrics"

    created = client.post(
        base,
        json={"name": "revenue", "label": "Revenue", "expression": "SUM(quantity * unit_price)",
              "number_format": "0,0.00"},
    )  # fmt: skip
    assert created.status_code == 201, created.text
    metric = created.json()
    assert metric["number_format"] == "0,0.00" and metric["is_builtin"] is False

    assert client.post(base, json={"name": "Revenue", "expression": "SUM(1)"}).status_code == 409
    # Static check on save: no query, but unsafe or malformed expressions are rejected.
    bad = client.post(base, json={"name": "bad", "expression": "SUM(x) FROM t"})
    assert bad.status_code == 400 and bad.json()["detail"]["kind"] == "invalid"

    edited = client.put(
        f"{base}/{metric['id']}",
        json={"name": "revenue", "label": "Revenue (EUR)", "expression": "SUM(quantity * unit_price)",
              "number_format": "0.0a"},
    )  # fmt: skip
    assert edited.status_code == 200
    assert edited.json()["label"] == "Revenue (EUR)"

    names = [m["name"] for m in client.get(f"/api/datasets/{dataset['id']}").json()["metrics"]]
    assert names == ["count", "revenue"]

    assert client.delete(f"{base}/{metric['id']}").status_code == 204
    assert client.delete(f"{base}/{metric['id']}").status_code == 404


def test_count_metric_cannot_be_deleted_or_changed(client: TestClient, connection_id: int) -> None:
    dataset = items(client, connection_id)
    [count] = dataset["metrics"]
    url = f"/api/datasets/{dataset['id']}/metrics/{count['id']}"
    response = client.delete(url)
    assert response.status_code == 400
    assert "can't be deleted" in response.json()["detail"]

    changed = client.put(url, json={"name": "count", "expression": "COUNT(id)"})
    assert changed.status_code == 400
    relabeled = client.put(
        url,
        json={"name": "count", "label": "Rows", "expression": "COUNT(*)", "number_format": "0,0"},
    )
    assert relabeled.status_code == 200 and relabeled.json()["label"] == "Rows"


# ---------- delete ----------


def test_delete_dataset(client: TestClient, connection_id: int) -> None:
    dataset = orders(client, connection_id)
    assert client.delete(f"/api/datasets/{dataset['id']}").status_code == 204
    assert client.get(f"/api/datasets/{dataset['id']}").status_code == 404
    assert client.delete(f"/api/datasets/{dataset['id']}").status_code == 404


def test_connection_in_use_cannot_be_deleted(client: TestClient, connection_id: int) -> None:
    orders(client, connection_id)
    create_ok(
        client, connection_id, name="Customers", kind="sql", sql="SELECT * FROM sales.customers"
    )
    response = client.delete(f"/api/connections/{connection_id}")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["message"] == (
        "This connection is used by 2 datasets: Customers, Orders. Delete those first."
    )
    assert detail["datasets"] == ["Customers", "Orders"]
    assert client.get(f"/api/connections/{connection_id}").status_code == 200


# ---------- awkward names on a real database ----------


@pytest.fixture
def quoting_schema() -> Iterator[str]:
    """A schema with awkward names in sampledb. Always dropped, even if the test fails."""
    url = URL.create(
        "postgresql+psycopg",
        username=os.environ["SAMPLEDB_USER"],
        password=os.environ["SAMPLEDB_PASSWORD"],
        host="sampledb",
        port=5432,
        database=os.environ["SAMPLEDB_DB"],
    )
    engine = create_engine(url)
    drop = text(f'DROP SCHEMA IF EXISTS "{QUOTING_SCHEMA}" CASCADE')
    try:
        with engine.begin() as conn:
            conn.execute(drop)  # leftovers from an interrupted run
            conn.execute(text(f'CREATE SCHEMA "{QUOTING_SCHEMA}"'))
            conn.execute(
                text(
                    f'CREATE TABLE "{QUOTING_SCHEMA}"."Order Items" ('
                    ' "select" integer, "Total Amount" numeric(10, 2), "CamelCase" text,'
                    ' "order" date)'
                )
            )
            conn.execute(
                text(
                    f'INSERT INTO "{QUOTING_SCHEMA}"."Order Items" VALUES'
                    " (1, 10.50, 'a', '2026-01-01'), (2, 4.50, 'b', '2026-01-02')"
                )
            )
            conn.execute(
                text(
                    f'CREATE TABLE "{QUOTING_SCHEMA}".empty_table ('
                    " id bigint, price numeric, name varchar(20), flag boolean,"
                    " created timestamptz, day date, payload bytea)"
                )
            )
        yield QUOTING_SCHEMA
    finally:
        with engine.begin() as conn:
            conn.execute(drop)
        engine.dispose()


def test_awkward_names_work_end_to_end(
    client: TestClient, connection_id: int, quoting_schema: str
) -> None:
    dataset = create_ok(
        client, connection_id, name="Awkward", kind="table", schema=quoting_schema,
        table_name="Order Items",
    )  # fmt: skip
    assert list(cols(dataset)) == ["select", "Total Amount", "CamelCase", "order"]
    assert dataset["main_time_column"] == "order"
    assert dataset["sqllab_sql"] == f'SELECT * FROM "{quoting_schema}"."Order Items"'

    rows = client.get(f"/api/datasets/{dataset['id']}/preview").json()["rows"]
    assert rows == [[1, 10.5, "a", "2026-01-01"], [2, 4.5, "b", "2026-01-02"]]

    url = f"/api/datasets/{dataset['id']}/metrics/validate"
    result = client.post(url, json={"expression": 'SUM("Total Amount") + COUNT("select")'}).json()
    assert result["ok"] is True, result
    assert float(result["value"]) == 17.0


def test_empty_table_gets_types_from_metadata(
    client: TestClient, connection_id: int, quoting_schema: str
) -> None:
    dataset = create_ok(
        client, connection_id, name="Empty table", kind="table", schema=quoting_schema,
        table_name="empty_table",
    )  # fmt: skip
    types = {name: c["generic_type"] for name, c in cols(dataset).items()}
    assert types == {
        "id": "number", "price": "number", "name": "string", "flag": "boolean",
        "created": "datetime", "day": "date", "payload": "other",
    }  # fmt: skip
    assert cols(dataset)["name"]["raw_type"] == "VARCHAR(20)"
    preview = client.get(f"/api/datasets/{dataset['id']}/preview").json()
    assert preview["rows"] == [] and len(preview["columns"]) == 7
