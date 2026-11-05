"""Query engine tests against the seeded sampledb (see sampledb/init/01_sales.sql)."""

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.engines import ConnectionDetails
from app.query import QueryError, run_query
from app.query.runner import execute_read_only
from app.query.validate import PreparedQuery

Payload = Callable[..., dict[str, Any]]


@pytest.fixture
def conn_id(client: TestClient, sampledb_payload: Payload) -> int:
    response = client.post("/api/connections", json=sampledb_payload())
    assert response.status_code == 201
    connection_id: int = response.json()["id"]
    return connection_id


@pytest.fixture
def details(sampledb_payload: Payload) -> ConnectionDetails:
    payload = sampledb_payload()
    del payload["name"]
    return ConnectionDetails(**payload)


def run(client: TestClient, conn_id: int, sql: str, **extra: Any) -> tuple[int, dict[str, Any]]:
    response = client.post("/api/query", json={"connection_id": conn_id, "sql": sql, **extra})
    body: dict[str, Any] = response.json()
    return response.status_code, body


def error_of(body: dict[str, Any]) -> dict[str, Any]:
    detail: dict[str, Any] = body["detail"]
    return detail


# ---------- successful queries ----------


def test_simple_select(client: TestClient, conn_id: int) -> None:
    code, body = run(client, conn_id, "SELECT id, status FROM sales.orders ORDER BY id LIMIT 3;")
    assert code == 200
    assert [c["name"] for c in body["columns"]] == ["id", "status"]
    assert [r[0] for r in body["rows"]] == [1, 2, 3]
    assert all(isinstance(r[1], str) for r in body["rows"])
    assert body["row_count"] == 3
    assert body["truncated"] is False
    assert isinstance(body["duration_ms"], int)


def test_select_on_view(client: TestClient, conn_id: int) -> None:
    code, body = run(
        client,
        conn_id,
        "SELECT channel, count(*) AS orders, sum(total) AS revenue "
        "FROM sales.order_totals GROUP BY channel ORDER BY channel",
    )
    assert code == 200
    assert [r[0] for r in body["rows"]] == ["mobile", "store", "web"]
    assert sum(r[1] for r in body["rows"]) == 800
    types = {c["name"]: c["type"] for c in body["columns"]}
    assert types == {"channel": "string", "orders": "number", "revenue": "number"}


def test_default_limit_and_truncation(client: TestClient, conn_id: int) -> None:
    # order_items has ~2,000 rows; the default limit is 1000.
    code, body = run(client, conn_id, "SELECT * FROM sales.order_items")
    assert code == 200
    assert body["row_count"] == 1000
    assert len(body["rows"]) == 1000
    assert body["truncated"] is True


def test_custom_limit(client: TestClient, conn_id: int) -> None:
    code, body = run(client, conn_id, "SELECT * FROM sales.orders", limit=10)
    assert (code, body["row_count"], body["truncated"]) == (200, 10, True)

    # Exactly as many rows as the limit: not truncated.
    code, body = run(client, conn_id, "SELECT * FROM sales.products", limit=30)
    assert (body["row_count"], body["truncated"]) == (30, False)


def test_limit_above_max_is_rejected(client: TestClient, conn_id: int) -> None:
    code, _ = run(client, conn_id, "SELECT 1", limit=10_001)
    assert code == 422


def test_run_query_clamps_limit(details: ConnectionDetails) -> None:
    result = run_query(details, "SELECT generate_series(1, 20000)", limit=50_000)
    assert result.row_count == 10_000
    assert result.truncated is True


def test_type_mapping(client: TestClient, conn_id: int) -> None:
    sql = """
        SELECT
            o.order_date,
            o.order_date::timestamp AS order_ts,
            o.order_date::timestamptz AS order_tstz,
            p.unit_price,
            o.id,
            count(*) OVER () AS total_count,
            1.5::float8 AS ratio,
            o.status = 'completed' AS is_completed,
            o.status,
            NULL::int AS nothing,
            '7c9e6679-7425-40de-944b-e07fc1f90ae7'::uuid AS uid,
            '\\x00ff'::bytea AS raw,
            '{"a": 1.5}'::jsonb AS doc,
            ARRAY[1, 2] AS nums,
            '12:30'::time AS at_time
        FROM sales.orders o
        JOIN sales.order_items oi ON oi.order_id = o.id
        JOIN sales.products p ON p.id = oi.product_id
        WHERE o.id = 1
        LIMIT 1
    """
    code, body = run(client, conn_id, sql)
    assert code == 200, body
    types = {c["name"]: (c["type"], c["db_type"]) for c in body["columns"]}
    assert types["order_date"] == ("date", "date")
    assert types["order_ts"] == ("datetime", "timestamp")
    assert types["order_tstz"] == ("datetime", "timestamptz")
    assert types["unit_price"] == ("number", "numeric")
    assert types["id"] == ("number", "int4")
    assert types["total_count"] == ("number", "int8")
    assert types["ratio"] == ("number", "float8")
    assert types["is_completed"] == ("boolean", "bool")
    assert types["status"] == ("string", "text")
    assert types["uid"] == ("other", "uuid")
    assert types["raw"] == ("other", "bytea")
    assert types["doc"] == ("other", "jsonb")
    assert types["nums"] == ("other", "int4[]")
    assert types["at_time"] == ("other", "time")

    row = dict(zip([c["name"] for c in body["columns"]], body["rows"][0], strict=True))
    assert row["order_date"] == "2024-11-12"
    assert row["order_ts"] == "2024-11-12T00:00:00"
    assert isinstance(row["unit_price"], (int, float))  # Decimal -> number
    assert row["ratio"] == 1.5
    assert isinstance(row["is_completed"], bool)
    assert row["nothing"] is None
    assert row["uid"] == "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    assert row["raw"] == "0x00ff"
    assert row["doc"] == {"a": 1.5}
    assert row["nums"] == [1, 2]
    assert row["at_time"] == "12:30:00"


def test_percent_and_colon_in_sql_are_not_parameters(client: TestClient, conn_id: int) -> None:
    code, body = run(
        client,
        conn_id,
        "SELECT 'x%y' AS a, ':name' AS b, count(*) FROM sales.customers WHERE email LIKE '%@example.com'",
    )
    assert code == 200, body
    assert body["rows"] == [["x%y", ":name", 150]]


def test_show_and_explain_are_allowed(client: TestClient, conn_id: int) -> None:
    assert run(client, conn_id, "SHOW search_path")[0] == 200
    code, body = run(client, conn_id, "EXPLAIN SELECT * FROM sales.orders")
    assert code == 200
    assert body["columns"][0]["name"] == "QUERY PLAN"


# ---------- timeout ----------


def test_timeout(client: TestClient, conn_id: int, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.api.query.DEFAULT_TIMEOUT_SECONDS", 1)
    code, body = run(client, conn_id, "SELECT pg_sleep(10)")
    assert code == 400
    assert error_of(body)["kind"] == "timeout"
    assert "timed out after 1 second" in error_of(body)["message"]


def test_timeout_cannot_be_switched_off_by_the_query(details: ConnectionDetails) -> None:
    """set_config() can disable statement_timeout from inside a SELECT; the client-side
    watchdog must still stop the query (timeout + 10s grace, shortened here)."""
    import app.query.runner as runner

    original = runner.CLIENT_GRACE_SECONDS
    runner.CLIENT_GRACE_SECONDS = 1
    try:
        with pytest.raises(QueryError) as exc_info:
            run_query(
                details,
                "SELECT set_config('statement_timeout', '0', true), pg_sleep(30)",
                timeout_seconds=1,
            )
    finally:
        runner.CLIENT_GRACE_SECONDS = original
    assert exc_info.value.kind == "timeout"


# ---------- read-only ----------


@pytest.mark.parametrize(
    ("sql", "keyword"),
    [
        ("INSERT INTO sales.products (name, category, unit_price) VALUES ('x', 'y', 1)", "INSERT"),
        ("UPDATE sales.orders SET status = 'x'", "UPDATE"),
        ("DELETE FROM sales.orders", "DELETE"),
        ("DROP TABLE sales.orders", "DROP"),
        ("CREATE TABLE sales.hack (id int)", "CREATE"),
        ("TRUNCATE sales.orders", "TRUNCATE"),
        ("ALTER TABLE sales.orders ADD COLUMN x int", "ALTER"),
        ("WITH d AS (DELETE FROM sales.orders RETURNING *) SELECT * FROM d", "DELETE"),
        ("SELECT * INTO sales.copy FROM sales.orders", "SELECT ... INTO"),
        ("EXPLAIN ANALYZE DELETE FROM sales.orders", "DELETE"),
        ("GRANT SELECT ON sales.orders TO PUBLIC", "GRANT"),
    ],
)
def test_writes_are_rejected(client: TestClient, conn_id: int, sql: str, keyword: str) -> None:
    code, body = run(client, conn_id, sql)
    assert code == 400
    assert error_of(body)["kind"] == "read_only"
    assert error_of(body)["message"].startswith(f"Vita is read-only: {keyword}")


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO sales.products (name, category, unit_price) VALUES ('x', 'y', 1)",
        "UPDATE sales.orders SET status = 'hacked'",
        "DELETE FROM sales.orders",
        "DROP TABLE sales.order_items",
        "CREATE TABLE sales.hack (id int)",
    ],
)
def test_database_read_only_transaction_blocks_writes_on_its_own(
    details: ConnectionDetails, sql: str
) -> None:
    """Second safety layer: even if the sqlglot check were bypassed, the read-only
    transaction refuses the write."""
    with pytest.raises(QueryError) as exc_info:
        execute_read_only(details, PreparedQuery(sql=sql, streamable=False), 10, 5)
    assert exc_info.value.kind == "read_only"
    assert "Vita is read-only" in exc_info.value.message


def test_data_unchanged_after_write_attempts(client: TestClient, conn_id: int) -> None:
    for sql in ("DELETE FROM sales.orders", "SELECT nextval('sales.orders_id_seq')"):
        assert run(client, conn_id, sql)[0] == 400
    _code, body = run(client, conn_id, "SELECT count(*) FROM sales.orders")
    assert body["rows"] == [[800]]


def test_other_statements_are_not_allowed(client: TestClient, conn_id: int) -> None:
    for sql in ("SET statement_timeout = 0", "COMMIT", "CALL some_proc()"):
        code, body = run(client, conn_id, sql)
        assert code == 400
        assert error_of(body)["kind"] in {"not_allowed", "read_only"}, sql


# ---------- validation and errors ----------


def test_multiple_statements_rejected(client: TestClient, conn_id: int) -> None:
    code, body = run(client, conn_id, "SELECT 1; SELECT 2;")
    assert code == 400
    assert error_of(body)["kind"] == "multiple_statements"
    assert "found 2" in error_of(body)["message"]


def test_trailing_semicolon_and_comments_are_fine(client: TestClient, conn_id: int) -> None:
    code, body = run(client, conn_id, "-- count\nSELECT count(*) FROM sales.products; -- done\n")
    assert code == 200, body
    assert body["rows"] == [[30]]


def test_semicolon_inside_string_is_one_statement(client: TestClient, conn_id: int) -> None:
    code, body = run(client, conn_id, "SELECT 'a;b' AS x")
    assert (code, body["rows"]) == (200, [["a;b"]])


def test_empty_query(client: TestClient, conn_id: int) -> None:
    code, body = run(client, conn_id, "  ;  ")
    assert code == 400
    assert error_of(body)["kind"] == "invalid"


def test_syntax_error_with_position(client: TestClient, conn_id: int) -> None:
    code, body = run(client, conn_id, "SELECT *\nFROM sales.orders\nWHERE")
    assert code == 400
    error = error_of(body)
    assert error["kind"] == "syntax"
    assert (error["line"], error["column"]) == (3, 5)
    assert "line 3" in error["message"]


def test_syntax_error_reported_by_postgres_has_position(client: TestClient, conn_id: int) -> None:
    # sqlglot accepts this, Postgres doesn't. The position must point into *our* SQL
    # (not the DECLARE ... CURSOR statement used for streaming).
    code, body = run(client, conn_id, "SELECT * FROM sales.orders\nWHERE id IN ()")
    assert code == 400
    error = error_of(body)
    assert error["kind"] == "syntax"
    assert (error["line"], error["column"]) == (2, 14)


def test_unknown_table(client: TestClient, conn_id: int) -> None:
    code, body = run(client, conn_id, "SELECT * FROM sales.nope")
    assert code == 400
    assert error_of(body)["kind"] == "not_found"
    assert 'relation "sales.nope" does not exist' in error_of(body)["message"]


def test_unknown_column(client: TestClient, conn_id: int) -> None:
    code, body = run(client, conn_id, "SELECT nope FROM sales.orders")
    assert code == 400
    assert error_of(body)["kind"] == "not_found"
    assert 'column "nope" does not exist' in error_of(body)["message"]


def test_connection_failure(client: TestClient, sampledb_payload: Payload) -> None:
    conn = client.post("/api/connections", json=sampledb_payload(password="wrong")).json()
    code, body = run(client, conn["id"], "SELECT 1")
    assert code == 400
    assert error_of(body)["kind"] == "connection"
    assert "Wrong username or password" in error_of(body)["message"]


def test_unknown_connection(client: TestClient) -> None:
    assert run(client, 999, "SELECT 1")[0] == 404


# ---------- history ----------


def test_history_logs_success_and_failure(client: TestClient, conn_id: int) -> None:
    run(client, conn_id, "SELECT * FROM sales.products")
    run(client, conn_id, "DELETE FROM sales.orders")
    run(client, conn_id, "SELECT nope FROM sales.orders")

    response = client.get("/api/query-history")
    assert response.status_code == 200
    page = response.json()
    assert page["total"] == 3
    newest, middle, oldest = page["items"]

    assert newest["sql"] == "SELECT nope FROM sales.orders"
    assert newest["status"] == "error"
    assert 'column "nope" does not exist' in newest["error_message"]
    assert newest["row_count"] is None

    assert middle["status"] == "error"
    assert middle["error_message"].startswith("Vita is read-only")

    assert oldest["status"] == "success"
    assert oldest["row_count"] == 30
    assert oldest["error_message"] is None
    assert oldest["connection_id"] == conn_id
    assert oldest["connection_name"] == "Sample DB"
    assert oldest["duration_ms"] >= 0
    assert oldest["started_at"]


def test_history_paging_and_filter(
    client: TestClient, conn_id: int, sampledb_payload: Payload
) -> None:
    for i in range(5):
        run(client, conn_id, f"SELECT {i}")
    other = client.post("/api/connections", json=sampledb_payload(name="Other")).json()["id"]
    run(client, other, "SELECT 'other'")

    page = client.get("/api/query-history", params={"limit": 2, "offset": 0}).json()
    assert page["total"] == 6
    assert [i["sql"] for i in page["items"]] == ["SELECT 'other'", "SELECT 4"]

    page = client.get("/api/query-history", params={"limit": 2, "offset": 2}).json()
    assert [i["sql"] for i in page["items"]] == ["SELECT 3", "SELECT 2"]

    page = client.get("/api/query-history", params={"connection_id": other}).json()
    assert page["total"] == 1

    assert client.get("/api/query-history", params={"limit": 500}).status_code == 422


def test_history_kept_when_connection_deleted(client: TestClient, conn_id: int) -> None:
    run(client, conn_id, "SELECT 1")
    client.delete(f"/api/connections/{conn_id}")
    item = client.get("/api/query-history").json()["items"][0]
    assert item["connection_id"] is None
    assert item["sql"] == "SELECT 1"
