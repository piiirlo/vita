"""Dashboards CRUD, layout validation, duplicate, and the chart delete blocks."""

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError


@pytest.fixture
def dataset_id(client: TestClient, sampledb_payload: Callable[..., dict[str, Any]]) -> int:
    connection = client.post("/api/connections", json=sampledb_payload())
    assert connection.status_code == 201, connection.text
    response = client.post(
        "/api/datasets",
        json={"name": "Orders", "connection_id": connection.json()["id"], "kind": "table",
              "schema": "sales", "table_name": "orders"},
    )  # fmt: skip
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


@pytest.fixture
def make_chart(client: TestClient, dataset_id: int) -> Callable[..., int]:
    def make(name: str, viz_type: str = "big_number", **query: Any) -> int:
        response = client.post(
            "/api/charts",
            json={"name": name, "viz_type": viz_type,
                  "params": {"query": {"dataset_id": dataset_id, "metrics": ["count"], **query}}},
        )  # fmt: skip
        assert response.status_code == 201, response.text
        return int(response.json()["id"])

    return make


def chart_tile(tile_id: str, chart_id: int, **pos: int) -> dict[str, Any]:
    return {"id": tile_id, "type": "chart", "chart_id": chart_id,
            "x": 0, "y": 0, "w": 6, "h": 8, **pos}  # fmt: skip


def text_tile(tile_id: str, text: str = "# Title", **pos: int) -> dict[str, Any]:
    return {"id": tile_id, "type": "text", "text": text, "x": 0, "y": 0, "w": 12, "h": 2, **pos}


def create(client: TestClient, name: str, layout: list[dict[str, Any]], **extra: Any) -> Any:
    return client.post("/api/dashboards", json={"name": name, "layout": layout, **extra})


def test_dashboard_crud(client: TestClient, make_chart: Callable[..., int]) -> None:
    total = make_chart("Total orders")
    line = make_chart(
        "Orders by day", viz_type="line", time={"column": "order_date", "grain": "day"}
    )
    layout = [
        text_tile("t1"),
        chart_tile("c1", total, y=2),
        chart_tile("c2", line, x=6, y=2),
    ]
    created = create(
        client, "Sales overview", layout, description="Main KPIs", refresh_interval="5m"
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["layout"] == layout
    assert body["refresh_interval"] == "5m"
    assert body["charts"] == {
        str(total): {"id": total, "name": "Total orders", "viz_type": "big_number"},
        str(line): {"id": line, "name": "Orders by day", "viz_type": "line"},
    }

    assert create(client, "SALES overview", []).status_code == 409
    assert create(client, "Other", []).status_code == 201

    listed = client.get("/api/dashboards").json()
    assert [d["name"] for d in listed] == ["Other", "Sales overview"]  # last updated first
    assert listed[1]["chart_count"] == 2
    assert [d["name"] for d in client.get("/api/dashboards", params={"q": "kpi"}).json()] == [
        "Sales overview"
    ]

    dashboard_id = body["id"]
    moved = [layout[0], layout[1], {**layout[2], "x": 0, "y": 10}]
    updated = client.put(
        f"/api/dashboards/{dashboard_id}",
        json={"name": "Sales overview", "layout": moved, "refresh_interval": "off"},
    )
    assert updated.status_code == 200, updated.text
    got = client.get(f"/api/dashboards/{dashboard_id}").json()
    assert got["layout"][2]["y"] == 10 and got["layout"][2]["x"] == 0
    assert got["refresh_interval"] == "off" and got["description"] is None
    assert (
        client.put(
            f"/api/dashboards/{dashboard_id}", json={"name": "other", "layout": []}
        ).status_code
        == 409
    )

    assert client.delete(f"/api/dashboards/{dashboard_id}").status_code == 204
    assert client.get(f"/api/dashboards/{dashboard_id}").status_code == 404
    # The charts are free again.
    assert client.delete(f"/api/charts/{total}").status_code == 204


@pytest.mark.parametrize(
    "tile",
    [
        {"id": "a", "type": "chart", "x": 0, "y": 0, "w": 6, "h": 4},  # no chart_id
        {
            "id": "a",
            "type": "text",
            "text": "x",
            "x": 20,
            "y": 0,
            "w": 6,
            "h": 4,
        },  # too wide (24 columns)
        {"id": "a", "type": "text", "text": "x", "x": -1, "y": 0, "w": 6, "h": 4},
        {"id": "a", "type": "text", "text": "x", "x": 0, "y": 0, "w": 0, "h": 4},
        {"id": "a", "type": "text", "text": "x", "x": 0, "y": 0, "w": 6, "h": 0},
        {"id": "a", "type": "image", "x": 0, "y": 0, "w": 6, "h": 4},  # unknown type
        {"id": "a", "type": "text", "text": "x", "chart_id": 1, "x": 0, "y": 0, "w": 6, "h": 4},
        {"id": "", "type": "text", "text": "x", "x": 0, "y": 0, "w": 6, "h": 4},
    ],
)
def test_invalid_tiles_are_rejected(client: TestClient, tile: dict[str, Any]) -> None:
    assert create(client, "Bad", [tile]).status_code == 422


def test_layout_validation(client: TestClient, make_chart: Callable[..., int]) -> None:
    chart = make_chart("Total orders")
    duplicate_ids = create(client, "Bad", [text_tile("a"), text_tile("a", y=2)])
    assert duplicate_ids.status_code == 422
    assert 'Duplicate tile id \\"a\\"' in duplicate_ids.text

    missing = create(client, "Bad", [chart_tile("a", chart), chart_tile("b", 9999, x=6)])
    assert missing.status_code == 400
    assert "9999" in missing.json()["detail"]
    assert client.get("/api/dashboards").json() == []

    assert create(client, "Bad", [{"bogus": 1}]).status_code == 422
    assert (
        client.post("/api/dashboards", json={"name": "Bad", "refresh_interval": "2m"}).status_code
        == 422
    )

    # The same chart may appear twice on one dashboard.
    assert (
        create(client, "Twice", [chart_tile("a", chart), chart_tile("b", chart, x=6)]).status_code
        == 201
    )


def test_duplicate(client: TestClient, make_chart: Callable[..., int]) -> None:
    chart = make_chart("Total orders")
    layout = [text_tile("t"), chart_tile("c", chart, y=2)]
    source = create(client, "Sales", layout, description="d", refresh_interval="1h").json()

    first = client.post(f"/api/dashboards/{source['id']}/duplicate")
    assert first.status_code == 201, first.text
    copy = first.json()
    assert copy["id"] != source["id"]
    assert copy["name"] == "Sales (copy)"
    assert (
        copy["layout"] == layout and copy["description"] == "d" and copy["refresh_interval"] == "1h"
    )
    assert copy["charts"] == source["charts"]

    second = client.post(f"/api/dashboards/{source['id']}/duplicate").json()
    assert second["name"] == "Sales (copy 2)"
    assert client.post("/api/dashboards/9999/duplicate").status_code == 404

    # Changing the copy leaves the original alone.
    client.put(f"/api/dashboards/{copy['id']}", json={"name": copy["name"], "layout": []})
    assert client.get(f"/api/dashboards/{source['id']}").json()["layout"] == layout


def test_add_chart_takes_the_first_free_spot(
    client: TestClient, make_chart: Callable[..., int]
) -> None:
    chart = make_chart("Total orders")
    dashboard = create(
        client, "Sales", [text_tile("t", h=3), chart_tile("c", chart, y=3, h=5)]
    ).json()
    response = client.post(f"/api/dashboards/{dashboard['id']}/charts", json={"chart_id": chart})
    assert response.status_code == 200, response.text
    added = response.json()["layout"][-1]
    assert added["type"] == "chart" and added["chart_id"] == chart
    # The right half of the top is free (new tiles are 12 x 16 on the 24-column grid).
    assert (added["x"], added["y"], added["w"], added["h"]) == (12, 0, 12, 16)
    # Full-width tiles leave no gap: then it goes below everything.
    full = create(client, "Full", [text_tile("t", w=24, h=3)]).json()
    below = client.post(f"/api/dashboards/{full['id']}/charts", json={"chart_id": chart}).json()
    assert (below["layout"][-1]["x"], below["layout"][-1]["y"]) == (0, 3)
    assert (
        client.post(
            f"/api/dashboards/{dashboard['id']}/charts", json={"chart_id": 9999}
        ).status_code
        == 400
    )


def test_chart_used_by_dashboards_cannot_be_deleted(
    client: TestClient, make_chart: Callable[..., int]
) -> None:
    chart = make_chart("Total orders")
    create(client, "B board", [chart_tile("c", chart)])
    a_board = create(client, "A board", [chart_tile("c", chart)]).json()

    response = client.delete(f"/api/charts/{chart}")
    assert response.status_code == 409
    assert response.json()["detail"] == {
        "message": "This chart is used by 2 dashboards: A board, B board. "
        "Remove it from those dashboards first.",
        "dashboards": ["A board", "B board"],
    }
    assert client.get(f"/api/charts/{chart}").status_code == 200

    # Removing the tile from one dashboard updates the block.
    client.put(
        f"/api/dashboards/{a_board['id']}", json={"name": "A board", "layout": [text_tile("t")]}
    )
    response = client.delete(f"/api/charts/{chart}")
    assert response.status_code == 409
    assert response.json()["detail"]["dashboards"] == ["B board"]


def test_database_also_blocks_deleting_a_used_chart(
    client: TestClient, make_chart: Callable[..., int], test_engine: Engine
) -> None:
    chart = make_chart("Total orders")
    create(client, "Board", [chart_tile("c", chart)])
    with pytest.raises(IntegrityError), test_engine.begin() as conn:
        conn.execute(text("DELETE FROM charts WHERE id = :id"), {"id": chart})
    assert client.get(f"/api/charts/{chart}").status_code == 200


# ---------- Part 10: the 24-column grid ----------


def _pixels(tile: dict[str, Any], cols: int, row: int, width: int) -> tuple[float, ...]:
    """Where react-grid-layout draws a tile (left, top, width, height) with a 12px margin."""
    x, y, w, h = (int(tile[k]) for k in "xywh")
    margin = 12
    col = (width - (cols - 1) * margin) / cols
    return (
        x * (col + margin),
        y * (row + margin),
        w * col + (w - 1) * margin,
        h * row + (h - 1) * margin,
    )


def test_layouts_are_rescaled_to_the_same_pixels() -> None:
    from app.dashboard_grid import GRID_COLUMNS, ROW_HEIGHT, scale_layout

    old = [
        {"id": "a", "type": "chart", "chart_id": 1, "x": 0, "y": 0, "w": 6, "h": 8},
        {"id": "b", "type": "text", "text": "hi", "x": 6, "y": 0, "w": 6, "h": 3},
        {"id": "c", "type": "chart", "chart_id": 2, "x": 3, "y": 8, "w": 9, "h": 5},
    ]
    new = scale_layout(old, 2)
    for before, after in zip(old, new, strict=True):
        assert after["id"] == before["id"] and after.get("text") == before.get("text")
        for width in (800, 1234, 1920):
            old_px = _pixels(before, cols=12, row=40, width=width)
            new_px = _pixels(after, cols=GRID_COLUMNS, row=ROW_HEIGHT, width=width)
            assert new_px == pytest.approx(old_px)
    # And back (the migration's downgrade).
    assert scale_layout(new, 0.5) == old


def test_tiles_use_the_24_column_grid(client: TestClient) -> None:
    ok = client.post("/api/dashboards", json={"name": "Wide", "layout": [
        {"id": "t", "type": "text", "text": "x", "x": 12, "y": 0, "w": 12, "h": 4}]})  # fmt: skip
    assert ok.status_code == 201, ok.text
    too_wide = client.post("/api/dashboards", json={"name": "Too wide", "layout": [
        {"id": "t", "type": "text", "text": "x", "x": 13, "y": 0, "w": 12, "h": 4}]})  # fmt: skip
    assert too_wide.status_code == 422


def test_dashboard_cache_setting(client: TestClient) -> None:
    created = client.post("/api/dashboards", json={"name": "Cached", "cache_ttl": 300})
    assert created.status_code == 201, created.text
    assert created.json()["cache_ttl"] == 300
    dashboard_id = created.json()["id"]
    default = client.put(f"/api/dashboards/{dashboard_id}", json={"name": "Cached"})
    assert default.json()["cache_ttl"] is None
    assert client.post("/api/dashboards", json={"name": "Bad", "cache_ttl": -1}).status_code == 422
    copy = client.post(f"/api/dashboards/{dashboard_id}/duplicate")
    assert copy.status_code in (200, 201), copy.text
