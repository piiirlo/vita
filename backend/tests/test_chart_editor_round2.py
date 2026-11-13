"""Part 13 round 2 (backend side): custom SQL metrics in charts, the first free spot for a
new tile, and which dashboards show a chart."""

import os
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import URL

from app.charts.usage import query_usage, sql_columns
from app.dashboard_grid import first_free_spot
from app.schemas.charts import ChartQuery

PRICE = {"sql": "SUM(quantity * unit_price) / NULLIF(SUM(quantity), 0)", "label": "Price per unit"}


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


@pytest.fixture
def items(client: TestClient, sampledb_payload: Callable[..., dict[str, Any]]) -> int:
    connection = client.post("/api/connections", json=sampledb_payload()).json()
    response = client.post(
        "/api/datasets",
        json={"name": "Items", "connection_id": connection["id"], "kind": "table",
              "schema": "sales", "table_name": "order_items"},
    )  # fmt: skip
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def big_number(client: TestClient, dataset_id: int, metric: Any) -> Any:
    return client.post(
        "/api/chart-data",
        json={"viz_type": "big_number", "query": {"dataset_id": dataset_id, "metrics": [metric]}},
    )


def test_a_custom_sql_metric_in_a_chart(client: TestClient, items: int, sampledb: Engine) -> None:
    response = big_number(client, items, PRICE)
    assert response.status_code == 200, response.text
    assert response.json()["columns"][0]["name"] == "Price per unit"
    with sampledb.connect() as conn:
        expected: Any = conn.execute(
            text(
                "SELECT SUM(quantity * unit_price) / NULLIF(SUM(quantity), 0) "
                "FROM sales.order_items"
            )
        ).scalar_one()
    assert float(response.json()["rows"][0][0]) == pytest.approx(float(expected))


@pytest.mark.parametrize(
    ("sql", "message"),
    [
        ("SUM(quantity); DROP TABLE sales.orders", "single SQL expression"),
        ("SUM(quantity) AS total", ""),
        ("SELECT 1", ""),
        ("*", "COUNT(*)"),
        ("SUM(", "syntax"),
    ],
)
def test_custom_sql_metrics_get_the_saved_metric_checks(
    client: TestClient, items: int, sql: str, message: str
) -> None:
    response = big_number(client, items, {"sql": sql, "label": "x"})
    assert response.status_code == 400, response.text
    assert message in response.json()["detail"]["message"]


def test_custom_sql_metrics_need_a_label(client: TestClient, items: int) -> None:
    assert big_number(client, items, {"sql": "COUNT(*)", "label": ""}).status_code == 422


def test_columns_used_by_custom_sql_metrics_are_protected(client: TestClient, items: int) -> None:
    chart = client.post(
        "/api/charts",
        json={"name": "Price", "viz_type": "big_number",
              "params": {"query": {"dataset_id": items, "metrics": [PRICE]}}},
    )  # fmt: skip
    assert chart.status_code == 201, chart.text
    dataset = client.get(f"/api/datasets/{items}").json()
    quantity = next(c for c in dataset["columns"] if c["name"] == "quantity")
    hidden = client.put(
        f"/api/datasets/{items}",
        json={"name": dataset["name"], "main_time_column": dataset["main_time_column"],
              "columns": [{"id": quantity["id"], "is_temporal": False, "is_dimension": False,
                           "is_hidden": True}]},
    )  # fmt: skip
    assert hidden.status_code == 409
    assert "Price" in hidden.json()["detail"]["message"]


def test_usage_reads_columns_from_custom_sql() -> None:
    assert sql_columns("SUM(a * b) / NULLIF(SUM(c), 0)") == {"a", "b", "c"}
    assert sql_columns("SUM(") == set()
    query = ChartQuery.model_validate({"dataset_id": 1, "metrics": [PRICE]})
    assert set(query_usage(query, None).columns) == {"quantity", "unit_price"}


# ---------- the first free spot ----------


def tile(x: int, y: int, w: int, h: int) -> dict[str, Any]:
    return {"x": x, "y": y, "w": w, "h": h}


@pytest.mark.parametrize(
    ("layout", "size", "spot"),
    [
        ([], (12, 16), (0, 0)),
        ([tile(0, 0, 12, 16)], (12, 16), (12, 0)),
        ([tile(0, 0, 12, 16), tile(12, 0, 12, 16)], (12, 16), (0, 16)),
        # A gap in the middle of the grid that fits.
        ([tile(0, 0, 24, 4), tile(0, 4, 8, 20), tile(20, 4, 4, 20), tile(0, 24, 24, 4)],
         (12, 16), (8, 4)),
        # A gap too small: below everything.
        ([tile(0, 0, 24, 4), tile(0, 4, 8, 10), tile(14, 4, 10, 10), tile(0, 14, 24, 4)],
         (12, 16), (0, 18)),
        ([], (40, 2), (0, 0)),  # wider than the grid: clamped
    ],
)  # fmt: skip
def test_first_free_spot(
    layout: list[dict[str, Any]], size: tuple[int, int], spot: tuple[int, int]
) -> None:
    assert first_free_spot(layout, *size) == spot


def test_a_chart_says_which_dashboards_show_it(client: TestClient, items: int) -> None:
    chart = client.post(
        "/api/charts",
        json={"name": "Items", "viz_type": "big_number",
              "params": {"query": {"dataset_id": items, "metrics": ["count"]}}},
    ).json()  # fmt: skip
    assert chart["dashboards"] == []
    for name in ("Sales", "Ops"):
        dashboard = client.post("/api/dashboards", json={"name": name, "layout": []}).json()
        client.post(f"/api/dashboards/{dashboard['id']}/charts", json={"chart_id": chart["id"]})
    got = client.get(f"/api/charts/{chart['id']}").json()
    assert [d["name"] for d in got["dashboards"]] == ["Ops", "Sales"]
    # Lists leave it out (one query per chart would be slow).
    assert all(c["dashboards"] == [] for c in client.get("/api/charts").json())
