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
