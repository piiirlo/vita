"""Part 13 round 3: tiles are placed freely, so migration 0013 stores the positions the old
grid showed (react-grid-layout's vertical compaction). The expected layouts below are what
react-grid-layout 2.3 itself returns: `docker compose exec frontend node
scripts/rgl-compact-check.mjs` prints them."""

from typing import Any

import pytest

from app.dashboard_grid import compact_vertical


def t(i: str, x: int, y: int, w: int, h: int) -> dict[str, Any]:
    return {"id": i, "type": "chart", "chart_id": 1, "x": x, "y": y, "w": w, "h": h}


CASES: dict[str, tuple[list[dict[str, Any]], list[tuple[str, int, int]]]] = {
    "gap_above": ([t("a", 0, 5, 12, 4)], [("a", 0, 0)]),
    "stacked": (
        [t("t", 0, 0, 24, 3), t("a", 0, 10, 12, 16), t("b", 12, 30, 12, 16)],
        [("t", 0, 0), ("a", 0, 3), ("b", 12, 3)],
    ),
    "pushed": (
        [t("a", 0, 0, 12, 8), t("b", 6, 4, 12, 8), t("c", 0, 2, 6, 4)],
        [("a", 0, 0), ("b", 6, 8), ("c", 0, 8)],
    ),
    "side_by_side": (
        [t("a", 12, 7, 12, 10), t("b", 0, 7, 12, 20), t("c", 0, 40, 24, 4)],
        [("a", 12, 0), ("b", 0, 0), ("c", 0, 20)],
    ),
    "out_of_order": (
        [t("c", 6, 20, 6, 6), t("a", 0, 0, 8, 6), t("b", 4, 3, 8, 6)],
        [("c", 6, 12), ("a", 0, 0), ("b", 4, 6)],
    ),
}


@pytest.mark.parametrize("name", list(CASES))
def test_compaction_matches_react_grid_layout(name: str) -> None:
    layout, expected = CASES[name]
    got = compact_vertical(layout)
    assert [(tile["id"], tile["x"], tile["y"]) for tile in got] == expected
    # Sizes, order and every other field are kept; the input isn't changed.
    assert [(a["w"], a["h"], a["type"]) for a in got] == [
        (b["w"], b["h"], b["type"]) for b in layout
    ]
    assert compact_vertical(got) == got  # already compact: nothing moves


def test_compaction_of_an_empty_layout() -> None:
    assert compact_vertical([]) == []


def test_new_tiles_stay_where_they_are_put(client: Any) -> None:
    """The API stores positions as given (no compaction): a tile low on the grid stays low."""
    layout = [{"id": "t", "type": "text", "text": "# Hi", "x": 0, "y": 20, "w": 24, "h": 4}]
    created = client.post("/api/dashboards", json={"name": "Free", "layout": layout})
    assert created.status_code == 201, created.text
    assert created.json()["layout"][0]["y"] == 20
