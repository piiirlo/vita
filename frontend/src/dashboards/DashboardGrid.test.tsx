/** The real react-grid-layout (page tests mock it): resizing from every edge and corner. jsdom
 * gives every element 1000x600 (test/setup.ts), so with 24 columns and a 12px margin one
 * column step is (1000 - 23 * 12) / 24 + 12 ≈ 42.2px and one row step is 14 + 12 = 26px. */
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DashboardGrid from "./DashboardGrid.tsx";
import { RESIZE_HANDLES, minTileSize, type GridItem } from "./layout.ts";
import { readSource } from "../test/readSource.ts";

const COL = (1000 - 23 * 12) / 24 + 12;
const ROW = 26;
// At the top: the grid compacts tiles upwards, so y stays 0 and top handles shrink the height.
const START: GridItem = { i: "a", x: 6, y: 0, w: 12, h: 16, minW: 6, minH: 10 };

function renderGrid(onLayoutChange: (items: readonly GridItem[]) => void, editing = true) {
  return render(
    <DashboardGrid items={[START]} editing={editing} onLayoutChange={onLayoutChange}>
      <div key="a">tile</div>
    </DashboardGrid>,
  );
}

/** Drag a resize handle by (dx, dy) pixels and return the last layout the grid reported. */
function resize(container: HTMLElement, handle: string, dx: number, dy: number, onLayoutChange: ReturnType<typeof vi.fn>) {
  const el = container.querySelector(`.react-resizable-handle-${handle}`);
  if (!el) throw new Error(`no ${handle} handle`);
  act(() => {
    fireEvent.mouseDown(el, { clientX: 500, clientY: 300, button: 0 });
  });
  act(() => {
    fireEvent.mouseMove(document, { clientX: 500 + dx / 2, clientY: 300 + dy / 2 });
    fireEvent.mouseMove(document, { clientX: 500 + dx, clientY: 300 + dy });
  });
  act(() => {
    fireEvent.mouseUp(document, { clientX: 500 + dx, clientY: 300 + dy });
  });
  const calls = onLayoutChange.mock.calls;
  return (calls.at(-1)?.[0] as GridItem[] | undefined)?.find((i) => i.i === "a");
}

describe("DashboardGrid resizing", () => {
  it("has a handle on every edge and corner; view mode doesn't resize", async () => {
    const { container, unmount } = renderGrid(vi.fn());
    for (const h of RESIZE_HANDLES) expect(container.querySelector(`.react-resizable-handle-${h}`)).not.toBeNull();
    unmount();
    const onLayoutChange = vi.fn();
    const view = renderGrid(onLayoutChange, false);
    const handle = view.container.querySelector(".react-resizable-handle-e");
    if (handle) resize(view.container, "e", 4 * COL, 0, onLayoutChange);
    expect(onLayoutChange).not.toHaveBeenCalled();
    // ...and its handles are hidden (no resize cursors).
    const css = await readSource("App.css");
    expect(css).toContain(".dash-grid:not(.editing) .react-resizable-handle {\n  display: none;");
  });

  // [handle, dx, dy, expected change]
  const cases: [string, number, number, Partial<GridItem>][] = [
    ["e", 2 * COL, 0, { x: 6, w: 14 }],
    ["w", -2 * COL, 0, { x: 4, w: 14 }],
    ["s", 0, 2 * ROW, { y: 0, h: 18 }],
    ["n", 0, 2 * ROW, { y: 0, h: 14 }], // the top edge moves down: shorter
    ["se", 2 * COL, 2 * ROW, { x: 6, y: 0, w: 14, h: 18 }],
    ["sw", -2 * COL, 2 * ROW, { x: 4, y: 0, w: 14, h: 18 }],
    ["ne", 2 * COL, 2 * ROW, { x: 6, y: 0, w: 14, h: 14 }],
    ["nw", -2 * COL, 2 * ROW, { x: 4, y: 0, w: 14, h: 14 }],
  ];
  it.each(cases)("resizing from %s saves the right layout", (handle, dx, dy, expected) => {
    const onLayoutChange = vi.fn();
    const { container } = renderGrid(onLayoutChange);
    const item = resize(container, handle, dx, dy, onLayoutChange);
    expect(item).toMatchObject(expected);
  });

  it("can't shrink a tile below its chart type's minimum", () => {
    const onLayoutChange = vi.fn();
    const { container } = renderGrid(onLayoutChange);
    const item = resize(container, "se", -20 * COL, -20 * ROW, onLayoutChange);
    expect(item).toMatchObject({ w: 6, h: 10 });
  });

  it("knows a readable minimum for every kind of tile", () => {
    const chart = { id: "c", type: "chart" as const, chart_id: 1, x: 0, y: 0, w: 12, h: 16 };
    expect(minTileSize(chart, "big_number")).toEqual({ w: 4, h: 8 });
    expect(minTileSize(chart, "pie")).toEqual({ w: 6, h: 12 });
    expect(minTileSize(chart, "bar")).toEqual({ w: 6, h: 10 });
    expect(minTileSize(chart, "gauge")).toEqual({ w: 4, h: 8 });
    expect(minTileSize(chart, "treemap")).toEqual({ w: 6, h: 12 });
    expect(minTileSize(chart, "funnel")).toEqual({ w: 6, h: 12 });
    expect(minTileSize(chart, "pivot_table")).toEqual({ w: 8, h: 10 });
    expect(minTileSize(chart, "area")).toEqual({ w: 6, h: 10 });
    expect(minTileSize(chart, "combo")).toEqual({ w: 6, h: 10 });
    expect(minTileSize({ id: "t", type: "text", text: "", x: 0, y: 0, w: 4, h: 4 }, undefined)).toEqual({ w: 3, h: 3 });
  });
});
