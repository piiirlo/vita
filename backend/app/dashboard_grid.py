"""The dashboard grid's geometry, and rescaling saved layouts when it changes.

Pixel geometry (react-grid-layout): with W the grid width, M the margin, C columns and R the
row height, a tile at column x spanning w columns is at x*(W - (C-1)*M)/C + x*M and is
w*(W - (C-1)*M)/C + (w-1)*M wide; at row y spanning h rows it is at y*(R+M) and h*R + (h-1)*M
tall. Going from (C=12, R=40, M=12) to (C=24, R=14, M=12) and doubling x, y, w, h gives the
same numbers for every W: existing dashboards keep their exact look.
"""

from typing import Any

GRID_COLUMNS = 24
ROW_HEIGHT = 14
GRID_MARGIN = 12

_KEYS = ("x", "y", "w", "h")


def first_free_spot(layout: list[dict[str, Any]], w: int, h: int) -> tuple[int, int]:
    """(x, y) of the first place, top to bottom then left to right, where a w x h tile fits
    without overlapping any tile (below everything when nothing fits higher up)."""
    w = min(w, GRID_COLUMNS)
    boxes = [(int(t["x"]), int(t["y"]), int(t["w"]), int(t["h"])) for t in layout]
    bottom = max((y + th for _, y, _, th in boxes), default=0)

    def free(x: int, y: int) -> bool:
        return all(
            x + w <= bx or bx + bw <= x or y + h <= by or by + bh <= y for bx, by, bw, bh in boxes
        )

    for y in range(bottom + 1):
        for x in range(GRID_COLUMNS - w + 1):
            if free(x, y):
                return x, y
    return 0, bottom


def scale_layout(layout: list[dict[str, Any]], factor: float) -> list[dict[str, Any]]:
    """Multiply every tile's x, y, w and h (rounding; w and h stay at least 1)."""
    scaled = []
    for tile in layout:
        tile = dict(tile)
        for key in _KEYS:
            if isinstance(tile.get(key), int):
                value = round(tile[key] * factor)
                tile[key] = max(1, value) if key in ("w", "h") else value
        scaled.append(tile)
    return scaled


# ---------- vertical compaction (what dashboards always showed before Part 13) ----------
#
# A port of react-grid-layout 2.3's verticalCompactor (src/core/compactors.ts, MIT): until
# Part 13 the grid pulled every tile up as far as it could go on screen, whatever positions
# were stored. Tiles now stay where they are put, so migration 0013 stores the compacted
# positions once: every existing dashboard keeps exactly the look it had.


def _collides(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if a["i"] == b["i"]:
        return False
    return not (
        a["x"] + a["w"] <= b["x"]
        or a["x"] >= b["x"] + b["w"]
        or a["y"] + a["h"] <= b["y"]
        or a["y"] >= b["y"] + b["h"]
    )


def _first_collision(layout: list[dict[str, Any]], item: dict[str, Any]) -> dict[str, Any] | None:
    return next((other for other in layout if _collides(other, item)), None)


def _resolve_collision(layout: list[dict[str, Any]], item: dict[str, Any], move_to: int) -> None:
    item["y"] += 1
    index = next(k for k, other in enumerate(layout) if other["i"] == item["i"])
    for other in layout[index + 1 :]:
        if other["y"] > item["y"] + item["h"]:
            break
        if _collides(item, other):
            _resolve_collision(layout, other, move_to + item["h"])
    item["y"] = move_to


def compact_vertical(tiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each tile pulled up as far as it goes (in row, then column order), never overlapping:
    react-grid-layout's vertical compaction, step for step. Returns new dicts, same order."""
    items = [dict(t, i=str(t.get("id", k))) for k, t in enumerate(tiles)]
    ordered = sorted(items, key=lambda t: (t["y"], t["x"]))  # stable, like Array.sort
    placed: list[dict[str, Any]] = []
    max_y = 0
    out: list[dict[str, Any] | None] = [None] * len(items)
    for original in ordered:
        item = dict(original)
        item["x"] = max(item["x"], 0)
        item["y"] = min(max(item["y"], 0), max_y)
        while item["y"] > 0 and _first_collision(placed, item) is None:
            item["y"] -= 1
        while (collision := _first_collision(placed, item)) is not None:
            _resolve_collision(ordered, item, collision["y"] + collision["h"])
        item["y"] = max(item["y"], 0)
        max_y = max(max_y, item["y"] + item["h"])
        placed.append(item)
        out[next(k for k, t in enumerate(items) if t is original)] = item
    result = []
    for tile, placed_item in zip(tiles, out, strict=True):
        assert placed_item is not None
        result.append({**tile, "x": placed_item["x"], "y": placed_item["y"]})
    return result
