# ruff: noqa: F811  (fixtures imported from test_charts are used as arguments)
"""Part 15: dashboard filters merged into chart data, targeting by column, the cache key,
column values, and saving filters on a dashboard."""

from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.api.charts as charts_api
import app.api.datasets as datasets_api
from tests.test_charts import (  # noqa: F401  (fixtures)
    column_settings,
    connection_id,
    expect,
    lines,
    orders,
    sampledb,
    save_columns,
)


@pytest.fixture
def products(client: TestClient, connection_id: int) -> int:
    """A dataset without a status column and without a time column."""
    response = client.post(
        "/api/datasets",
        json={"name": "Products", "connection_id": connection_id, "kind": "table",
              "schema": "sales", "table_name": "products"},
    )  # fmt: skip
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def data(
    client: TestClient, dataset_id: int, dash: list[dict[str, Any]], **query: Any
) -> dict[str, Any]:
    body = {
        "viz_type": "big_number",
        "query": {"dataset_id": dataset_id, "metrics": ["count"], **query},
        "dashboard_filters": dash,
        "cache_ttl": 0,
    }
    response = client.post("/api/chart-data", json=body)
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


def count(rows: list[list[Any]]) -> Any:
    return rows[0][0]


STATUS: dict[str, Any] = {
    "id": "st",
    "kind": "values",
    "column": "status",
    "values": ["shipped", "returned"],
}


# ---------- merging ----------


def test_values_filter_becomes_an_in_condition(
    client: TestClient, lines: int, expect: Callable[..., Any]
) -> None:
    result = data(client, lines, [STATUS])
    assert result["dashboard_filters_applied"] == ["st"]
    assert "IN ('shipped', 'returned')" in result["sql"]
    want = expect("SELECT COUNT(*) FROM lines WHERE status IN ('shipped', 'returned')")
    assert count(result["rows"]) == want[0][0]


def test_values_filter_with_null_also_matches_empty_values(
    client: TestClient, lines: int, expect: Callable[..., Any]
) -> None:
    f = {"id": "w", "kind": "values", "column": "web_or_mobile", "values": ["web", None]}
    result = data(client, lines, [f])
    want = expect("SELECT COUNT(*) FROM lines WHERE web_or_mobile = 'web' OR web_or_mobile IS NULL")
    assert count(result["rows"]) == want[0][0]


def test_values_are_literals_never_sql(client: TestClient, lines: int) -> None:
    f = {"id": "x", "kind": "values", "column": "status", "values": ["a'); DROP TABLE x; --"]}
    result = data(client, lines, [f])
    assert count(result["rows"]) == 0
    assert "'a''); DROP TABLE x; --'" in result["sql"]


def test_range_filter_on_a_number_column(
    client: TestClient, lines: int, expect: Callable[..., Any]
) -> None:
    f = {"id": "q", "kind": "range", "column": "quantity", "min": 2, "max": 3}
    result = data(client, lines, [f])
    assert result["dashboard_filters_applied"] == ["q"]
    want = expect("SELECT COUNT(*) FROM lines WHERE quantity >= 2 AND quantity <= 3")
    assert count(result["rows"]) == want[0][0]
    only_min = data(client, lines, [{**f, "max": None}])
    assert count(only_min["rows"]) == expect("SELECT COUNT(*) FROM lines WHERE quantity >= 2")[0][0]


def test_time_filter_replaces_the_charts_own_range(
    client: TestClient, lines: int, monkeypatch: pytest.MonkeyPatch, expect: Callable[..., Any]
) -> None:
    monkeypatch.setattr(charts_api, "today", lambda: date(2026, 3, 15))
    own = {"column": "order_date", "grain": None, "range": {"kind": "last_7_days"}}
    f = {"id": "t", "kind": "time", "time_range": {"kind": "this_year"}}
    result = data(client, lines, [f], time=own)
    assert result["dashboard_filters_applied"] == ["t"]
    assert result["range_start"] == "2026-01-01"
    assert result["range_end"] == "2026-12-31"
    want = expect("SELECT COUNT(*) FROM lines WHERE order_date >= '2026-01-01'")
    assert count(result["rows"]) == want[0][0]


def test_time_filter_uses_the_main_time_column_of_a_chart_without_one(
    client: TestClient, lines: int
) -> None:
    f = {"id": "t", "kind": "time", "time_range": {"kind": "custom", "start": "2025-01-01",
                                                   "end": "2025-01-31"}}  # fmt: skip
    result = data(client, lines, [f])
    assert result["dashboard_filters_applied"] == ["t"]
    assert result["range_start"] == "2025-01-01"
    assert result["range_end"] == "2025-01-31"


def test_chart_and_dashboard_filters_combine(
    client: TestClient, lines: int, expect: Callable[..., Any]
) -> None:
    own = [{"column": "channel", "operator": "=", "value": "web"}]
    result = data(client, lines, [STATUS], filters=own)
    want = expect(
        "SELECT COUNT(*) FROM lines WHERE channel = 'web' AND status IN ('shipped', 'returned')"
    )
    assert count(result["rows"]) == want[0][0]


def test_empty_selections_filter_nothing(client: TestClient, lines: int) -> None:
    plain = data(client, lines, [])
    empty: list[dict[str, Any]] = [
        {"id": "a", "kind": "values", "column": "status", "values": []},
        {"id": "b", "kind": "range", "column": "quantity"},
        {"id": "c", "kind": "time", "time_range": {"kind": "none"}},
        {"id": "d", "kind": "time"},
    ]
    result = data(client, lines, empty)
    assert result["dashboard_filters_applied"] == []
    assert result["sql"] == plain["sql"]


# ---------- targeting: a filter applies when the dataset can take it ----------


def test_filters_skip_datasets_without_the_column(client: TestClient, products: int) -> None:
    filters: list[dict[str, Any]] = [
        STATUS,
        {"id": "t", "kind": "time", "time_range": {"kind": "last_30_days"}},
        {"id": "q", "kind": "range", "column": "quantity", "min": 1},
    ]
    result = data(client, products, filters)
    assert result["dashboard_filters_applied"] == []
    assert "WHERE" not in result["sql"]


def test_filters_apply_per_dataset(client: TestClient, lines: int, orders: int) -> None:
    filters: list[dict[str, Any]] = [
        STATUS,
        {"id": "q", "kind": "range", "column": "quantity", "min": 1},
    ]
    assert data(client, lines, filters)["dashboard_filters_applied"] == ["st", "q"]
    # Orders has a status but no quantity.
    assert data(client, orders, filters)["dashboard_filters_applied"] == ["st"]


def test_range_filter_skips_text_columns_and_mismatched_values_are_skipped(
    client: TestClient, lines: int
) -> None:
    on_text = {"id": "r", "kind": "range", "column": "status", "min": 1}
    on_number = {"id": "v", "kind": "values", "column": "quantity", "values": ["not a number"]}
    result = data(client, lines, [on_text, on_number])
    assert result["dashboard_filters_applied"] == []


def test_hidden_columns_are_not_filtered(client: TestClient, lines: int) -> None:
    dataset = client.get(f"/api/datasets/{lines}").json()
    save_columns(client, lines, column_settings(dataset, "status", is_hidden=True))
    assert data(client, lines, [STATUS])["dashboard_filters_applied"] == []


# ---------- cache key ----------


def test_cache_key_includes_dashboard_filters(
    client: TestClient, lines: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs: list[str] = []
    real = charts_api.run_query  # type: ignore[attr-defined]

    def counting(details: Any, sql: str, **kwargs: Any) -> Any:
        runs.append(sql)
        return real(details, sql, **kwargs)

    monkeypatch.setattr(charts_api, "run_query", counting)

    def cached(filters: list[dict[str, Any]]) -> dict[str, Any]:
        body = {"viz_type": "big_number", "query": {"dataset_id": lines, "metrics": ["count"]},
                "dashboard_filters": filters}  # fmt: skip
        response = client.post("/api/chart-data", json=body)
        assert response.status_code == 200, response.text
        result: dict[str, Any] = response.json()
        return result

    plain = cached([])
    shipped = cached([{**STATUS, "values": ["shipped"]}])
    returned = cached([{**STATUS, "values": ["returned"]}])
    assert len(runs) == 3  # every filter value is its own cache entry
    assert shipped["cached_at"] is None and returned["cached_at"] is None
    again = cached([{**STATUS, "values": ["shipped"]}])
    assert again["cached_at"] is not None
    assert again["rows"] == shipped["rows"] != plain["rows"]
    assert again["dashboard_filters_applied"] == ["st"]
    assert len(runs) == 3


# ---------- column values ----------


def test_column_values(client: TestClient, lines: int, expect: Callable[..., Any]) -> None:
    response = client.get(f"/api/datasets/{lines}/values", params={"column": "status"})
    assert response.status_code == 200, response.text
    body = response.json()
    want = [r[0] for r in expect("SELECT DISTINCT status FROM lines ORDER BY status")]
    assert body["values"] == want
    assert body["truncated"] is False
    assert body["cached_at"] is None
    assert client.get(f"/api/datasets/{lines}/values", params={"column": "status"}).json()[
        "cached_at"
    ]


def test_column_values_search_and_limit(
    client: TestClient, lines: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    found = client.get(f"/api/datasets/{lines}/values", params={"column": "status", "q": "SHIP"})
    assert found.json()["values"] == ["shipped"]
    monkeypatch.setattr(datasets_api, "MAX_COLUMN_VALUES", 2)
    few = client.get(f"/api/datasets/{lines}/values", params={"column": "order_id"}).json()
    assert len(few["values"]) == 2
    assert few["truncated"] is True


def test_column_values_errors(client: TestClient, lines: int) -> None:
    unknown = client.get(f"/api/datasets/{lines}/values", params={"column": "nope"})
    assert unknown.status_code == 400
    assert "nope" in unknown.json()["detail"]["message"]
    assert client.get("/api/datasets/999/values", params={"column": "x"}).status_code == 404


# ---------- saved on the dashboard ----------


def test_dashboard_saves_its_filters(client: TestClient, lines: int) -> None:
    filters: list[dict[str, Any]] = [
        {"id": "t", "kind": "time", "label": "Period",
         "default": {"time_range": {"kind": "last_90_days"}}},
        {"id": "st", "kind": "values", "label": "Status", "column": "status",
         "dataset_id": lines, "targets": None, "default": {"values": ["shipped"]}},
        {"id": "q", "kind": "range", "column": "quantity", "targets": [1, 2]},
    ]  # fmt: skip
    created = client.post("/api/dashboards", json={"name": "Filtered", "filters": filters})
    assert created.status_code == 201, created.text
    body = created.json()
    assert [f["id"] for f in body["filters"]] == ["t", "st", "q"]
    assert body["filters"][1]["default"]["values"] == ["shipped"]
    assert body["filters"][2]["targets"] == [1, 2]

    # Older clients leave filters out: they are kept.
    kept = client.put(f"/api/dashboards/{body['id']}", json={"name": "Filtered"})
    assert len(kept.json()["filters"]) == 3
    copy = client.post(f"/api/dashboards/{body['id']}/duplicate").json()
    assert len(copy["filters"]) == 3
    cleared = client.put(f"/api/dashboards/{body['id']}", json={"name": "Filtered", "filters": []})
    assert cleared.json()["filters"] == []


@pytest.mark.parametrize(
    "bad",
    [
        {"id": "a", "kind": "values", "column": "status"},  # no dataset
        {"id": "a", "kind": "range"},  # no column
        {"id": "a b", "kind": "time"},  # not URL-safe
        {"id": "a", "kind": "time", "default": {"oops": 1}},
    ],
)
def test_invalid_filters_are_rejected(client: TestClient, bad: dict[str, Any]) -> None:
    response = client.post("/api/dashboards", json={"name": "Bad", "filters": [bad]})
    assert response.status_code == 422


def test_duplicate_filter_ids_are_rejected(client: TestClient) -> None:
    filters = [{"id": "a", "kind": "time"}, {"id": "a", "kind": "time"}]
    response = client.post("/api/dashboards", json={"name": "Bad", "filters": filters})
    assert response.status_code == 422


def test_values_filter_dataset_must_exist_in_the_project(client: TestClient, lines: int) -> None:
    f = {"id": "s", "kind": "values", "column": "status", "dataset_id": 999}
    response = client.post("/api/dashboards", json={"name": "Bad", "filters": [f]})
    assert response.status_code == 400
    other = client.post("/api/projects", json={"name": "Other"}).json()
    f = {**f, "dataset_id": lines}
    response = client.post(
        "/api/dashboards", json={"name": "Elsewhere", "project_id": other["id"], "filters": [f]}
    )
    assert response.status_code == 400
    assert "another project" in response.json()["detail"]


# ---------- round 2: dependent filters, cross-filtering switch, delete protection ----------


def values_of(client: TestClient, dataset_id: int, column: str, **params: Any) -> list[Any]:
    response = client.get(f"/api/datasets/{dataset_id}/values", params={"column": column, **params})
    assert response.status_code == 200, response.text
    values: list[Any] = response.json()["values"]
    return values


def test_values_limited_by_parent_filters(
    client: TestClient, lines: int, expect: Callable[..., Any]
) -> None:
    import json

    parent = [{"id": "ch", "kind": "values", "column": "channel", "values": ["web"]}]
    got = values_of(client, lines, "status", filters=json.dumps(parent))
    want = expect("SELECT DISTINCT status FROM lines WHERE channel = 'web' ORDER BY status")
    assert got == [r[0] for r in want]

    period = [
        {"id": "t", "kind": "time",
         "time_range": {"kind": "custom", "start": "2025-01-01", "end": "2025-01-07"}},
        {"id": "x", "kind": "values", "column": "nope", "values": ["skipped"]},
    ]  # fmt: skip
    got = values_of(client, lines, "order_date", filters=json.dumps(period))
    want = expect(
        "SELECT DISTINCT order_date FROM lines "
        "WHERE order_date BETWEEN '2025-01-01' AND '2025-01-07' ORDER BY order_date"
    )
    assert got == [r[0] for r in want]
    # Different parent values are different cache entries.
    other = [{"id": "ch", "kind": "values", "column": "channel", "values": ["store"]}]
    assert values_of(client, lines, "channel", filters=json.dumps(other)) == ["store"]
    assert values_of(client, lines, "channel", filters=json.dumps(parent)) == ["web"]


def test_invalid_parent_filters_are_rejected(client: TestClient, lines: int) -> None:
    response = client.get(
        f"/api/datasets/{lines}/values", params={"column": "status", "filters": '[{"id": 1}]'}
    )
    assert response.status_code == 422


def test_depends_on_must_name_values_filters_of_the_dashboard(
    client: TestClient, lines: int
) -> None:
    country = {"id": "co", "kind": "values", "column": "channel", "dataset_id": lines}
    city = {**country, "id": "ci", "column": "status", "depends_on": ["co"]}
    ok = client.post("/api/dashboards", json={"name": "Deps", "filters": [country, city]})
    assert ok.status_code == 201, ok.text
    assert ok.json()["filters"][1]["depends_on"] == ["co"]
    for bad in (
        [country, {**city, "depends_on": ["missing"]}],
        [{**country, "depends_on": ["co"]}],
        [country, {"id": "t", "kind": "time", "depends_on": ["co"]}],
    ):
        response = client.post("/api/dashboards", json={"name": "Bad deps", "filters": bad})
        assert response.status_code == 422, bad


def test_cross_filtering_switch(client: TestClient) -> None:
    created = client.post("/api/dashboards", json={"name": "Cross"}).json()
    assert created["cross_filtering"] is True
    url = f"/api/dashboards/{created['id']}"
    off = client.put(url, json={"name": "Cross", "cross_filtering": False}).json()
    assert off["cross_filtering"] is False
    kept = client.put(url, json={"name": "Cross"}).json()
    assert kept["cross_filtering"] is False
    assert client.post(f"{url}/duplicate").json()["cross_filtering"] is False


def test_dataset_used_by_a_dashboard_filter_cannot_be_deleted(
    client: TestClient, lines: int
) -> None:
    f = {"id": "st", "kind": "values", "column": "status", "dataset_id": lines}
    for name in ("Sales", "Returns"):
        client.post("/api/dashboards", json={"name": name, "filters": [f]})
    response = client.delete(f"/api/datasets/{lines}")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["message"] == (
        "This dataset is used by the filters of 2 dashboards: Returns, Sales. "
        "Remove those filters first."
    )
    assert detail["dashboards"] == ["Returns", "Sales"]
    for d in client.get("/api/dashboards").json():
        client.put(f"/api/dashboards/{d['id']}", json={"name": d["name"], "filters": []})
    assert client.delete(f"/api/datasets/{lines}").status_code == 204
