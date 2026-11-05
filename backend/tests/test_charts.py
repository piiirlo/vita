"""Chart data and charts CRUD against the real sampledb (Postgres).

Results are compared with hand-written SQL run directly on sampledb (the data is random
but fixed, so expected values are computed, not hard-coded).
"""

import os
from collections.abc import Callable, Iterator
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import URL

import app.api.charts as charts_api

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


def chart_data(client: TestClient, viz: str, dataset_id: int, **query: Any) -> dict[str, Any]:
    response = client.post(
        "/api/chart-data", json={"viz_type": viz, "query": {"dataset_id": dataset_id, **query}}
    )
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def chart_error(client: TestClient, viz: str, dataset_id: int, **query: Any) -> dict[str, Any]:
    response = client.post(
        "/api/chart-data", json={"viz_type": viz, "query": {"dataset_id": dataset_id, **query}}
    )
    assert response.status_code == 400, response.text
    detail: dict[str, Any] = response.json()["detail"]
    return detail


def total(client: TestClient, dataset_id: int, **query: Any) -> Any:
    data = chart_data(client, "big_number", dataset_id, metrics=["count"], **query)
    return data["rows"][0][0]


# ---------- time grains ----------


@pytest.mark.parametrize("grain", ["day", "week", "month", "quarter", "year"])
def test_time_grains(
    client: TestClient, lines: int, expect: Callable[..., Any], grain: str
) -> None:
    data = chart_data(client, "line", lines, metrics=["revenue"], time={"grain": grain})
    assert [c["name"] for c in data["columns"]] == ["order_date", "revenue"]
    assert data["columns"][0]["type"] == "date"  # a real date column
    assert data["rows"] == expect(
        f"SELECT date_trunc('{grain}', order_date)::date, SUM(line_total) "
        "FROM lines GROUP BY 1 ORDER BY 1"
    )
    assert f"DATE_TRUNC('{grain}', \"order_date\")" in data["sql"]


def test_weeks_start_on_monday(client: TestClient, lines: int) -> None:
    data = chart_data(client, "line", lines, metrics=["count"], time={"grain": "week"})
    assert {date.fromisoformat(row[0]).weekday() for row in data["rows"]} == {0}


def test_table_dataset_with_grain(
    client: TestClient, orders: int, expect: Callable[..., Any]
) -> None:
    data = chart_data(client, "bar", orders, metrics=["count"], time={"grain": "quarter"})
    assert data["rows"] == expect(
        "SELECT date_trunc('quarter', order_date)::date, COUNT(*) FROM sales.orders GROUP BY 1 ORDER BY 1"
    )
    assert 'FROM "sales"."orders"' in data["sql"]


# ---------- filters ----------


@pytest.mark.parametrize(
    ("filter_", "where"),
    [
        ({"column": "status", "operator": "=", "value": "completed"}, "status = 'completed'"),
        ({"column": "status", "operator": "!=", "value": "completed"}, "status <> 'completed'"),
        ({"column": "quantity", "operator": ">", "value": 2}, "quantity > 2"),
        ({"column": "quantity", "operator": ">=", "value": "2"}, "quantity >= 2"),
        ({"column": "unit_price", "operator": "<", "value": 20.5}, "unit_price < 20.5"),
        ({"column": "unit_price", "operator": "<=", "value": 24.99}, "unit_price <= 24.99"),
        ({"column": "channel", "operator": "IN", "value": ["web", "store"]}, "channel IN ('web', 'store')"),
        ({"column": "channel", "operator": "NOT IN", "value": ["web"]}, "channel NOT IN ('web')"),
        ({"column": "order_date", "operator": "BETWEEN", "value": ["2025-01-01", "2025-03-31"]},
         "order_date BETWEEN '2025-01-01' AND '2025-03-31'"),
        ({"column": "quantity", "operator": "BETWEEN", "value": [2, 3]}, "quantity BETWEEN 2 AND 3"),
        ({"column": "web_or_mobile", "operator": "IS NULL"}, "web_or_mobile IS NULL"),
        ({"column": "web_or_mobile", "operator": "IS NOT NULL"}, "web_or_mobile IS NOT NULL"),
        ({"column": "status", "operator": "LIKE", "value": "OMP"}, "status ILIKE '%omp%'"),
    ],
)  # fmt: skip
def test_filter_operators(
    client: TestClient, lines: int, expect: Callable[..., Any], filter_: dict[str, Any], where: str
) -> None:
    [[expected]] = expect(f"SELECT COUNT(*) FROM lines WHERE {where}")
    assert 0 < expected < 1967  # the filter really filters
    assert total(client, lines, filters=[filter_]) == expected


@pytest.mark.parametrize(
    "value",
    ["'; DROP TABLE sales.orders; --", "x' OR '1'='1", 'say "hi"', "back\\slash", "100%", "a_b"],
)
def test_filter_values_are_plain_text(
    client: TestClient, lines: int, sampledb: Engine, value: str
) -> None:
    for operator in ("=", "LIKE"):
        assert (
            total(
                client, lines, filters=[{"column": "status", "operator": operator, "value": value}]
            )
            == 0
        )
    assert (
        total(client, lines, filters=[{"column": "status", "operator": "IN", "value": [value]}])
        == 0
    )
    with sampledb.connect() as conn:
        assert conn.scalar(text("SELECT COUNT(*) FROM sales.orders")) == 800  # still there


def test_like_matches_wildcards_literally(client: TestClient, lines: int) -> None:
    # "_" would match any single character if it weren't escaped.
    assert (
        total(
            client, lines, filters=[{"column": "status", "operator": "LIKE", "value": "c_mpleted"}]
        )
        == 0
    )
    assert (
        total(client, lines, filters=[{"column": "status", "operator": "LIKE", "value": "ple"}]) > 0
    )


# ---------- metrics and dimensions ----------


def test_saved_and_adhoc_metrics(
    client: TestClient, lines: int, expect: Callable[..., Any]
) -> None:
    data = chart_data(
        client, "big_number", lines,
        metrics=["revenue"],
    )  # fmt: skip
    [[revenue, distinct_orders, avg_qty, first_day, last_day, lines_count]] = expect(
        "SELECT SUM(line_total), COUNT(DISTINCT order_id), AVG(quantity), MIN(order_date), "
        "MAX(order_date), COUNT(quantity) FROM lines"
    )
    assert data["rows"] == [[revenue]]

    data = chart_data(
        client, "table", lines,
        metrics=[
            "revenue",
            {"column": "line_total", "aggregate": "SUM", "label": "revenue (ad-hoc)"},
            {"column": "order_id", "aggregate": "COUNT_DISTINCT", "label": "orders"},
            {"column": "quantity", "aggregate": "AVG"},
            {"column": "order_date", "aggregate": "MIN"},
            {"column": "order_date", "aggregate": "MAX"},
            {"column": "quantity", "aggregate": "COUNT"},
        ],
    )  # fmt: skip
    assert [c["name"] for c in data["columns"]] == [
        "revenue", "revenue (ad-hoc)", "orders", "AVG(quantity)", "MIN(order_date)",
        "MAX(order_date)", "COUNT(quantity)",
    ]  # fmt: skip
    row = data["rows"][0]
    assert row[0] == row[1] == revenue
    assert row[2] == distinct_orders == 800
    # High-precision numerics come back as strings (Part 3 serializer keeps every digit).
    assert float(row[3]) == pytest.approx(avg_qty)
    assert row[4:] == [first_day, last_day, lines_count]


def test_multiple_dimensions(client: TestClient, lines: int, expect: Callable[..., Any]) -> None:
    data = chart_data(
        client, "table", lines,
        metrics=["count", "revenue"], dimensions=["status", "channel"],
        order_by={"by": "revenue", "descending": True},
    )  # fmt: skip
    assert data["rows"] == expect(
        "SELECT status, channel, COUNT(*), SUM(line_total) FROM lines GROUP BY 1, 2 ORDER BY 4 DESC"
    )
    assert len(data["rows"]) == 12


def test_null_dimension_values_come_back_as_null(client: TestClient, lines: int) -> None:
    data = chart_data(client, "table", lines, metrics=["count"], dimensions=["web_or_mobile"],
                      order_by={"by": "web_or_mobile", "descending": False})  # fmt: skip
    assert [row[0] for row in data["rows"]] == [None, "mobile", "web"]  # NULL sorts lowest


# ---------- series limit ----------


def test_series_limit_keeps_top_n_series(
    client: TestClient, lines: int, expect: Callable[..., Any]
) -> None:
    top2 = [
        r[0]
        for r in expect("SELECT status FROM lines GROUP BY 1 ORDER BY SUM(line_total) DESC LIMIT 2")
    ]
    data = chart_data(
        client, "line", lines,
        metrics=["revenue"], series="status", series_limit=2, time={"grain": "quarter"},
    )  # fmt: skip
    assert {row[1] for row in data["rows"]} == set(top2)
    assert data["rows"] == expect(
        "SELECT date_trunc('quarter', order_date)::date, status, SUM(line_total) FROM lines "
        f"WHERE status IN ('{top2[0]}', '{top2[1]}') GROUP BY 1, 2 ORDER BY 1, 2"
    )
    assert "JOIN (" in data["sql"] and "LIMIT 2" in data["sql"]

    everything = chart_data(client, "line", lines, metrics=["revenue"], series="status",
                            series_limit=None, time={"grain": "quarter"})  # fmt: skip
    assert {row[1] for row in everything["rows"]} == {
        "completed",
        "shipped",
        "cancelled",
        "returned",
    }


def test_series_limit_respects_filters_and_keeps_null_series(
    client: TestClient, lines: int, expect: Callable[..., Any]
) -> None:
    data = chart_data(
        client, "bar", lines,
        metrics=["count"], dimensions=["status"], series="web_or_mobile", series_limit=3,
    )  # fmt: skip
    assert {row[1] for row in data["rows"]} == {None, "web", "mobile"}  # NULL series joined too
    assert sum(row[2] for row in data["rows"]) == 1967

    # Top series are computed within the filters: only web/store rows, top 1 of those.
    filtered = chart_data(
        client, "bar", lines,
        metrics=["count"], dimensions=["status"], series="channel", series_limit=1,
        filters=[{"column": "channel", "operator": "IN", "value": ["store", "mobile"]}],
    )  # fmt: skip
    [[top]] = expect("SELECT channel FROM lines WHERE channel IN ('store', 'mobile') "
                     "GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1")  # fmt: skip
    assert {row[1] for row in filtered["rows"]} == {top}


# ---------- time ranges ----------


@pytest.mark.parametrize(
    ("kind", "where"),
    [
        ("last_7_days", "order_date >= '2026-03-08' AND order_date < '2026-03-16'"),
        ("last_30_days", "order_date >= '2026-02-13' AND order_date < '2026-03-16'"),
        ("last_90_days", "order_date >= '2025-12-15' AND order_date < '2026-03-16'"),
        ("last_12_months", "order_date >= '2025-03-15' AND order_date < '2026-03-16'"),
        ("this_year", "order_date >= '2026-01-01' AND order_date < '2027-01-01'"),
        ("last_year", "order_date >= '2025-01-01' AND order_date < '2026-01-01'"),
    ],
)
def test_time_ranges(
    client: TestClient,
    lines: int,
    expect: Callable[..., Any],
    monkeypatch: pytest.MonkeyPatch,
    kind: str,
    where: str,
) -> None:
    monkeypatch.setattr(charts_api, "today", lambda: date(2026, 3, 15))
    [[expected]] = expect(f"SELECT COUNT(*) FROM lines WHERE {where}")
    assert expected > 0
    assert total(client, lines, time={"range": {"kind": kind}}) == expected


def test_custom_time_range_includes_the_end_date(
    client: TestClient, lines: int, expect: Callable[..., Any]
) -> None:
    [[expected]] = expect(
        "SELECT COUNT(*) FROM lines WHERE order_date BETWEEN '2025-06-01' AND '2025-06-30'"
    )
    rng = {"kind": "custom", "start": "2025-06-01", "end": "2025-06-30"}
    assert total(client, lines, time={"range": rng}) == expected
    # Time range + grain + explicit column together.
    data = chart_data(client, "line", lines, metrics=["count"],
                      time={"column": "order_date", "grain": "month", "range": rng})  # fmt: skip
    assert data["rows"] == [["2025-06-01", expected]]


def test_invalid_custom_range(client: TestClient, lines: int) -> None:
    response = client.post("/api/chart-data", json={"viz_type": "big_number", "query": {
        "dataset_id": lines, "metrics": ["count"],
        "time": {"range": {"kind": "custom", "start": "2025-02-01", "end": "2025-01-01"}}}})  # fmt: skip
    assert response.status_code == 422


# ---------- order, limits, raw records ----------


def test_order_by_and_row_limit(client: TestClient, lines: int, expect: Callable[..., Any]) -> None:
    data = chart_data(client, "bar", lines, metrics=["revenue"], dimensions=["status"],
                      order_by={"by": "status", "descending": True})  # fmt: skip
    assert [r[0] for r in data["rows"]] == ["shipped", "returned", "completed", "cancelled"]

    data = chart_data(client, "bar", lines, metrics=["revenue"], dimensions=["status"],
                      order_by={"by": "revenue", "descending": False}, row_limit=2)  # fmt: skip
    assert data["rows"] == expect(
        "SELECT status, SUM(line_total) FROM lines GROUP BY 1 ORDER BY 2 LIMIT 2"
    )
    assert data["truncated"] is True and data["row_count"] == 2
    assert data["sql"].rstrip().endswith("LIMIT 3")

    exact = chart_data(
        client, "bar", lines, metrics=["revenue"], dimensions=["status"], row_limit=4
    )
    assert exact["truncated"] is False and exact["row_count"] == 4


def test_raw_records(client: TestClient, lines: int, expect: Callable[..., Any]) -> None:
    data = chart_data(
        client, "table", lines,
        columns=["order_id", "status", "line_total"],
        filters=[{"column": "channel", "operator": "=", "value": "store"}],
        order_by={"by": "line_total", "descending": True}, row_limit=5,
    )  # fmt: skip
    assert [c["name"] for c in data["columns"]] == ["order_id", "status", "line_total"]
    assert [r[2] for r in data["rows"]] == [
        r[0]
        for r in expect(
            "SELECT line_total FROM lines WHERE channel = 'store' ORDER BY 1 DESC LIMIT 5"
        )
    ]


# ---------- validation errors (through the API) ----------


def test_validation_errors_are_clear_400s(client: TestClient, lines: int) -> None:
    assert chart_error(client, "table", lines, metrics=["nope"])["message"].startswith(
        'Unknown metric "nope"'
    )
    detail = chart_error(client, "table", lines, metrics=["count"], dimensions=["quantity"])
    assert detail["kind"] == "invalid" and "Mark it as a dimension" in detail["message"]
    detail = chart_error(
        client, "line", lines, metrics=["count"], time={"column": "status", "grain": "day"}
    )
    assert "is not a time column" in detail["message"]
    detail = chart_error(client, "table", lines, metrics=["count"],
                         filters=[{"column": "quantity", "operator": "=", "value": "two"}])  # fmt: skip
    assert "is not a number" in detail["message"]
    response = client.post(
        "/api/chart-data",
        json={"viz_type": "table", "query": {"dataset_id": 999, "metrics": ["count"]}},
    )
    assert response.status_code == 404


def test_hidden_and_missing_columns_are_rejected(client: TestClient, lines: int) -> None:
    dataset = client.get(f"/api/datasets/{lines}").json()
    status_col = next(c for c in dataset["columns"] if c["name"] == "status")
    keys = ("id", "label", "generic_type_override", "is_temporal", "is_dimension", "description")
    settings = {**{k: status_col[k] for k in keys}, "is_hidden": True}
    response = client.put(f"/api/datasets/{lines}", json={
        "name": dataset["name"], "description": None, "main_time_column": "order_date",
        "columns": [settings]})  # fmt: skip
    assert response.status_code == 200, response.text
    assert (
        "is hidden"
        in chart_error(client, "table", lines, metrics=["count"], dimensions=["status"])["message"]
    )

    # A column dropped from the SQL is "missing".
    response = client.put(f"/api/datasets/{lines}", json={
        "name": dataset["name"], "description": None, "main_time_column": "order_date",
        "sql": LINES_SQL.replace("o.channel, o.customer_id", "o.customer_id")})  # fmt: skip
    assert response.status_code == 200, response.text
    assert (
        "no longer exists"
        in chart_error(client, "table", lines, metrics=["count"], dimensions=["channel"])["message"]
    )


def test_query_errors_from_the_database(client: TestClient, connection_id: int, lines: int) -> None:
    # A saved metric that is valid SQL but fails on the data: the database error comes back.
    client.post(
        f"/api/datasets/{lines}/metrics", json={"name": "broken", "expression": "SUM(status::int)"}
    )
    detail = chart_error(client, "big_number", lines, metrics=["broken"])
    assert detail["kind"] != "invalid"
    assert "invalid input syntax" in detail["message"]


# ---------- saved charts ----------


def chart_payload(dataset_id: int, name: str = "Revenue by month", **query: Any) -> dict[str, Any]:
    return {
        "name": name,
        "description": "Monthly revenue",
        "viz_type": "line",
        "params": {
            "query": {
                "dataset_id": dataset_id,
                "metrics": ["revenue"],
                "time": {"grain": "month"},
                **query,
            },
            "display": {"show_points": True},
        },
    }


def test_chart_crud(client: TestClient, lines: int, orders: int) -> None:
    created = client.post("/api/charts", json=chart_payload(lines))
    assert created.status_code == 201, created.text
    chart = created.json()
    assert chart["dataset_id"] == lines and chart["dataset_name"] == "Order lines"
    assert chart["params"]["display"] == {"show_points": True}
    assert chart["params"]["query"]["row_limit"] == 1000  # defaults filled in

    assert (
        client.post("/api/charts", json=chart_payload(lines, name="revenue BY month")).status_code
        == 409
    )

    other = client.post("/api/charts", json={**chart_payload(orders, name="Orders"),
                                             "params": {"query": {"dataset_id": orders, "metrics": ["count"],
                                                                  "time": {"grain": "day"}}}})  # fmt: skip
    assert other.status_code == 201, other.text

    names = [c["name"] for c in client.get("/api/charts").json()]
    assert sorted(names) == ["Orders", "Revenue by month"]
    assert [c["name"] for c in client.get("/api/charts", params={"q": "order lines"}).json()] == [
        "Revenue by month"
    ]

    updated = client.put(
        f"/api/charts/{chart['id']}", json={**chart_payload(lines), "viz_type": "bar"}
    )
    assert updated.status_code == 200 and updated.json()["viz_type"] == "bar"
    assert client.get(f"/api/charts/{chart['id']}").json()["viz_type"] == "bar"

    assert client.delete(f"/api/charts/{chart['id']}").status_code == 204
    assert client.get(f"/api/charts/{chart['id']}").status_code == 404


def test_saving_an_invalid_chart_is_rejected(client: TestClient, lines: int) -> None:
    response = client.post("/api/charts", json=chart_payload(lines, metrics=["nope"]))
    assert response.status_code == 400
    assert response.json()["detail"]["message"].startswith('Unknown metric "nope"')
    response = client.post("/api/charts", json=chart_payload(999))
    assert response.status_code == 400
    bad_params = chart_payload(lines)
    bad_params["params"]["extra"] = 1
    assert client.post("/api/charts", json=bad_params).status_code == 422


def test_dataset_used_by_charts_cannot_be_deleted(client: TestClient, lines: int) -> None:
    client.post("/api/charts", json=chart_payload(lines, name="B chart"))
    client.post("/api/charts", json=chart_payload(lines, name="A chart"))
    response = client.delete(f"/api/datasets/{lines}")
    assert response.status_code == 409
    assert response.json()["detail"] == {
        "message": "This dataset is used by 2 charts: A chart, B chart. Delete those first.",
        "charts": ["A chart", "B chart"],
    }
    assert client.get(f"/api/datasets/{lines}").status_code == 200


# ---------- round 1 fixes: aligned ranges, NULL-aware filters, blocking breaking changes ----------


def test_first_bucket_is_a_whole_period(
    client: TestClient, lines: int, expect: Callable[..., Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(charts_api, "today", lambda: date(2026, 3, 15))
    data = chart_data(client, "line", lines, metrics=["count"],
                      time={"grain": "month", "range": {"kind": "last_90_days"}})  # fmt: skip
    # last 90 days starts 2025-12-15; snapped to 2025-12-01, so December is complete.
    assert data["rows"][0][0] == "2025-12-01"
    assert data["rows"] == expect(
        "SELECT date_trunc('month', order_date)::date, COUNT(*) FROM lines "
        "WHERE order_date >= '2025-12-01' AND order_date < '2026-03-16' GROUP BY 1 ORDER BY 1"
    )
    # Without a grain the exact dates are kept.
    [[exact]] = expect(
        "SELECT COUNT(*) FROM lines WHERE order_date >= '2025-12-15' AND order_date < '2026-03-16'"
    )
    assert total(client, lines, time={"range": {"kind": "last_90_days"}}) == exact


@pytest.mark.parametrize(
    ("filter_", "where"),
    [
        # web_or_mobile is NULL for store orders: "everything except" keeps them.
        ({"column": "web_or_mobile", "operator": "!=", "value": "web"}, "web_or_mobile IS DISTINCT FROM 'web'"),
        ({"column": "web_or_mobile", "operator": "NOT IN", "value": ["web"]},
         "web_or_mobile IS NULL OR web_or_mobile <> 'web'"),
        ({"column": "web_or_mobile", "operator": "NOT IN", "value": ["web", None]}, "web_or_mobile = 'mobile'"),
        ({"column": "web_or_mobile", "operator": "IN", "value": ["web", None]},
         "web_or_mobile = 'web' OR web_or_mobile IS NULL"),
        ({"column": "web_or_mobile", "operator": "IN", "value": [None]}, "web_or_mobile IS NULL"),
    ],
)  # fmt: skip
def test_null_aware_filters(
    client: TestClient, lines: int, expect: Callable[..., Any], filter_: dict[str, Any], where: str
) -> None:
    [[expected]] = expect(f"SELECT COUNT(*) FROM lines WHERE {where}")
    assert 0 < expected < 1967
    assert total(client, lines, filters=[filter_]) == expected


def test_saved_chart_pins_its_time_column(client: TestClient, lines: int) -> None:
    chart = client.post("/api/charts", json=chart_payload(lines)).json()
    assert chart["params"]["query"]["time"]["column"] == "order_date"


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


def test_metric_used_by_charts_cannot_be_deleted_or_renamed(client: TestClient, lines: int) -> None:
    client.post("/api/charts", json=chart_payload(lines, name="Revenue line"))
    client.post("/api/charts", json=chart_payload(lines, name="Another"))
    dataset = client.get(f"/api/datasets/{lines}").json()
    revenue = next(m for m in dataset["metrics"] if m["name"] == "revenue")
    url = f"/api/datasets/{lines}/metrics/{revenue['id']}"

    response = client.delete(url)
    assert response.status_code == 409
    assert response.json()["detail"]["message"] == (
        'Metric "revenue" is used by 2 charts: Another, Revenue line. Remove it from those charts first.'
    )
    renamed = client.put(url, json={"name": "rev", "expression": "SUM(line_total)"})
    assert renamed.status_code == 409
    # Changing the label or expression is fine.
    relabeled = client.put(
        url, json={"name": "revenue", "label": "Turnover", "expression": "SUM(line_total)"}
    )
    assert relabeled.status_code == 200

    unused = client.post(
        f"/api/datasets/{lines}/metrics", json={"name": "unused", "expression": "SUM(quantity)"}
    ).json()
    assert client.delete(f"/api/datasets/{lines}/metrics/{unused['id']}").status_code == 204


def test_columns_used_by_charts_cannot_be_hidden_or_broken(client: TestClient, lines: int) -> None:
    payload = chart_payload(lines, name="By channel", series="channel",
                            filters=[{"column": "quantity", "operator": ">", "value": 1}])  # fmt: skip
    assert client.post("/api/charts", json=payload).status_code == 201
    dataset = client.get(f"/api/datasets/{lines}").json()

    hide = save_columns(client, lines, column_settings(dataset, "quantity", is_hidden=True))
    assert hide.status_code == 409
    assert hide.json()["detail"]["message"] == (
        'Column "quantity" is used by 1 chart: By channel. Remove it from those charts first.'
    )
    not_a_dimension = save_columns(
        client, lines, column_settings(dataset, "channel", is_dimension=False)
    )
    assert not_a_dimension.status_code == 409  # it's the chart's series
    not_temporal = save_columns(client, lines, column_settings(dataset, "order_date", is_temporal=False),
                                main_time_column=None)  # fmt: skip
    assert not_temporal.status_code == 409  # it's the chart's time column

    # Unused columns, and harmless changes to used ones, are fine.
    ok = save_columns(client, lines, column_settings(dataset, "unit_price", is_hidden=True),
                      column_settings(dataset, "channel", label="Sales channel"))  # fmt: skip
    assert ok.status_code == 200, ok.text


def test_missing_column_used_by_a_chart_cannot_be_removed(client: TestClient, lines: int) -> None:
    assert client.post("/api/charts", json=chart_payload(lines, name="Quantities", metrics=[
        {"column": "quantity", "aggregate": "SUM"}])).status_code == 201  # fmt: skip
    dataset = client.get(f"/api/datasets/{lines}").json()
    # The SQL no longer has quantity: the column becomes "missing" (the chart breaks, as expected).
    response = client.put(f"/api/datasets/{lines}", json={
        "name": dataset["name"], "description": None, "main_time_column": "order_date",
        "sql": LINES_SQL.replace("oi.quantity, ", "")})  # fmt: skip
    assert response.status_code == 200, response.text
    quantity = next(c for c in response.json()["columns"] if c["name"] == "quantity")
    assert quantity["is_missing"]
    removed = save_columns(client, lines, delete_column_ids=[quantity["id"]])
    assert removed.status_code == 409
    assert "Quantities" in removed.json()["detail"]["message"]
