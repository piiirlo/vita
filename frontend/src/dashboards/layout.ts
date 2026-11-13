/** Dashboard layout helpers (pure). Tiles live on a 24-column grid; y and h are in rows. */
import type { DashboardTile, RefreshInterval, VizType } from "../api.ts";

export const GRID_COLUMNS = 24;
export const ROW_HEIGHT = 14; // px (24 columns, half-height rows: see backend app/dashboard_grid.py)
export const GRID_MARGIN = 12; // px between tiles

export const CHART_TILE_SIZE = { w: 12, h: 16 };
export const TEXT_TILE_SIZE = { w: 24, h: 4 };

/** Below this width the view mode stacks tiles in one column. */
export const NARROW_QUERY = "(max-width: 767px)";

export const REFRESH_INTERVALS: { value: RefreshInterval; label: string; ms: number | null }[] = [
  { value: "off", label: "Off", ms: null },
  { value: "1m", label: "Every minute", ms: 60_000 },
  { value: "5m", label: "Every 5 minutes", ms: 5 * 60_000 },
  { value: "15m", label: "Every 15 minutes", ms: 15 * 60_000 },
  { value: "1h", label: "Every hour", ms: 60 * 60_000 },
];

export const refreshMs = (interval: RefreshInterval): number | null =>
  REFRESH_INTERVALS.find((r) => r.value === interval)?.ms ?? null;

export function newTileId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** First row below every tile. */
export function bottomRow(tiles: DashboardTile[]): number {
  return tiles.reduce((max, t) => Math.max(max, t.y + t.h), 0);
}

/** Where a new w-wide tile goes: next to the tiles of the last row if it fits, else below. */
export function nextPosition(tiles: DashboardTile[], w: number): { x: number; y: number } {
  const bottom = bottomRow(tiles);
  if (tiles.length === 0) return { x: 0, y: 0 };
  // Tiles that reach the bottom row form the "last row".
  const lastRow = tiles.filter((t) => t.y + t.h === bottom);
  const top = Math.min(...lastRow.map((t) => t.y));
  const blocking = tiles.filter((t) => t.y + t.h > top);
  const right = blocking.reduce((max, t) => Math.max(max, t.x + t.w), 0);
  if (right + w <= GRID_COLUMNS) return { x: right, y: top };
  return { x: 0, y: bottom };
}

export function addChartTile(tiles: DashboardTile[], chartId: number): DashboardTile[] {
  const { w, h } = CHART_TILE_SIZE;
  return [...tiles, { id: newTileId(), type: "chart", chart_id: chartId, ...nextPosition(tiles, w), w, h }];
}

export function addTextTile(tiles: DashboardTile[], text = "## Title"): DashboardTile[] {
  const { w, h } = TEXT_TILE_SIZE;
  return [...tiles, { id: newTileId(), type: "text", text, ...nextPosition(tiles, w), w, h }];
}

export type GridItem = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number };

/** The smallest a tile can be resized to (24 columns, 14px rows), so charts stay readable. */
export function minTileSize(tile: DashboardTile, viz: VizType | undefined): { w: number; h: number } {
  if (tile.type === "text") return { w: 3, h: 3 };
  switch (viz) {
    case "big_number":
    case "gauge":
      return { w: 4, h: 8 };
    case "table":
      return { w: 6, h: 8 };
    case "pivot_table":
      return { w: 8, h: 10 };
    case "pie":
    case "treemap":
    case "funnel":
    case "heatmap":
    case "scatter":
      return { w: 6, h: 12 };
    case "world_map":
      return { w: 8, h: 14 };
    default: // bar, line, area, combo, histogram, or not loaded yet
      return { w: 6, h: 10 };
  }
}

export function toGridItems(tiles: DashboardTile[], vizOf: (chartId: number) => VizType | undefined = () => undefined): GridItem[] {
  return tiles.map((t) => {
    const min = minTileSize(t, t.type === "chart" ? vizOf(t.chart_id) : undefined);
    return { i: t.id, x: t.x, y: t.y, w: t.w, h: t.h, minW: min.w, minH: min.h };
  });
}

/** Copy positions from the grid onto the tiles (unknown items are ignored). */
export function applyGridItems(tiles: DashboardTile[], items: readonly GridItem[]): DashboardTile[] {
  const byId = new Map(items.map((i) => [i.i, i]));
  let changed = false;
  const next = tiles.map((t) => {
    const item = byId.get(t.id);
    if (!item || (item.x === t.x && item.y === t.y && item.w === t.w && item.h === t.h)) return t;
    changed = true;
    return { ...t, x: item.x, y: item.y, w: item.w, h: item.h };
  });
  return changed ? next : tiles;
}

/** Reading order for the one-column (narrow screen) view: top to bottom, then left to right. */
export function stackOrder(tiles: DashboardTile[]): DashboardTile[] {
  return [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Pixel height of a tile that is h rows tall. */
export const tileHeight = (h: number): number => h * ROW_HEIGHT + (h - 1) * GRID_MARGIN;

/** Comparable form of a layout (tile order doesn't matter). */
export function layoutKey(tiles: DashboardTile[]): string {
  return JSON.stringify([...tiles].sort((a, b) => a.id.localeCompare(b.id)));
}

/** Tiles resize from any edge or corner. */
export const RESIZE_HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

// ---------- free placement (Part 13) ----------

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Auto-fit on drop: the free rectangle a tile lands in, when it is a real gap (something
 * below it), as the tile's new position and size; null to keep the tile as it is (it lands
 * in open space, its corner is on another tile, or the gap is smaller than its minimum).
 * Starting from the cell under the tile's top-left corner: as wide as that row is free, up
 * to the first row above that isn't free across that width, down to the first row below
 * that isn't. */
export function fitToGap(
  items: readonly (Box & { i: string })[],
  id: string,
  at: Box,
  min: { w: number; h: number },
  cols: number = GRID_COLUMNS,
): Box | null {
  const others = items.filter((t) => t.i !== id);
  const bottom = others.reduce((max, t) => Math.max(max, t.y + t.h), 0);
  const free = (x: number, y: number, w = 1, h = 1) => x >= 0 && x + w <= cols && y >= 0 && !others.some((t) => overlaps(t, { x, y, w, h }));
  const x0 = Math.min(Math.max(at.x, 0), cols - 1);
  const y0 = Math.max(at.y, 0);
  if (!free(x0, y0)) return null;
  let left = x0;
  while (left > 0 && free(left - 1, y0)) left--;
  let right = x0 + 1;
  while (right < cols && free(right, y0)) right++;
  const width = right - left;
  let top = y0;
  while (top > 0 && free(left, top - 1, width, 1)) top--;
  let end = y0 + 1;
  while (end < bottom && free(left, end, width, 1)) end++;
  // Nothing below in those columns: open space, not a gap.
  if (end >= bottom) return null;
  const fit = { x: left, y: top, w: width, h: end - top };
  if (fit.w < min.w || fit.h < min.h) return null;
  if (fit.x === at.x && fit.y === at.y && fit.w === at.w && fit.h === at.h) return null;
  return fit;
}
