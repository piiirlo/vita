/** Part 13 round 3: tiles go anywhere and stay there (no forced compaction), never overlap
 * (others move out of the way), fill a gap they are dropped into (within their minimum size,
 * the dashed outline showing the final size first), and "Tidy up" compacts on demand.
 * jsdom has no layout, so pointer drags can't be simulated reliably: the grid component is
 * replaced by one that hands over its callbacks (what react-grid-layout calls during a drag),
 * and react-grid-layout's own moveElement (what a drag runs) shows tiles never overlap. */
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { moveElement, type Layout, type LayoutItem } from "react-grid-layout";
import { freeCompactor, pushDown } from "./compactor.ts";
import { describe, expect, it, vi } from "vitest";
import DashboardGrid from "./DashboardGrid.tsx";
import { tidyUp } from "./gridTidy.ts";
import { fitToGap, type GridItem } from "./layout.ts";

type GridProps = {
  compactor: unknown;
  onDrag(layout: Layout, oldItem: LayoutItem | null, newItem: LayoutItem | null, placeholder: LayoutItem | null): void;
  onDragStop(layout: Layout, oldItem: LayoutItem | null, newItem: LayoutItem | null, placeholder: LayoutItem | null): void;
  children: ReactNode;
};
let grid: GridProps | null = null;
vi.mock("react-grid-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-grid-layout")>();
  return {
    ...actual,
    useContainerWidth: () => ({ width: 1000, containerRef: { current: null }, mounted: true }),
    default: (props: GridProps) => {
      grid = props;
      return <div>{props.children}</div>;
    },
  };
});

// A gap in the middle: x 8-20, y 4-24, closed below by "bottom".
const AROUND: GridItem[] = [
  { i: "top", x: 0, y: 0, w: 24, h: 4 },
  { i: "left", x: 0, y: 4, w: 8, h: 20 },
  { i: "right", x: 20, y: 4, w: 4, h: 20 },
  { i: "bottom", x: 0, y: 24, w: 24, h: 4 },
];
const MOVER: GridItem = { i: "m", x: 0, y: 28, w: 6, h: 10, minW: 6, minH: 10 };

const overlap = (a: GridItem, b: GridItem) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function noOverlaps(items: readonly GridItem[]) {
  for (const a of items) for (const b of items) if (a.i !== b.i) expect(overlap(a, b), `${a.i} overlaps ${b.i}`).toBe(false);
}

describe("fitToGap", () => {
  it("fills the free rectangle a tile lands in", () => {
    expect(fitToGap([...AROUND, MOVER], "m", { x: 10, y: 6, w: 6, h: 10 }, { w: 6, h: 10 })).toEqual({ x: 8, y: 4, w: 12, h: 20 });
  });

  it("keeps the tile as it is in open space, on another tile, or in a gap too small", () => {
    // Open space below everything: not a gap.
    expect(fitToGap([...AROUND, MOVER], "m", { x: 0, y: 40, w: 6, h: 10 }, { w: 6, h: 10 })).toBeNull();
    // Its corner on another tile: the grid moves that one instead.
    expect(fitToGap([...AROUND, MOVER], "m", { x: 2, y: 6, w: 6, h: 10 }, { w: 6, h: 10 })).toBeNull();
    // A 12 x 20 gap is too small for a tile that needs 14 columns.
    expect(fitToGap([...AROUND, MOVER], "m", { x: 10, y: 6, w: 6, h: 10 }, { w: 14, h: 10 })).toBeNull();
    expect(fitToGap([...AROUND, MOVER], "m", { x: 10, y: 6, w: 6, h: 10 }, { w: 6, h: 22 })).toBeNull();
  });

  it("stays inside the grid and the gap's own edges", () => {
    // A gap at the right edge, between two tiles, above a full-width one.
    const items: GridItem[] = [
      { i: "a", x: 0, y: 0, w: 16, h: 10 },
      { i: "b", x: 0, y: 10, w: 24, h: 6 },
    ];
    expect(fitToGap(items, "m", { x: 20, y: 2, w: 6, h: 4 }, { w: 4, h: 4 })).toEqual({ x: 16, y: 0, w: 8, h: 10 });
  });
});

describe("Tidy up", () => {
  it("pulls every tile up (react-grid-layout's own compaction), sizes kept", () => {
    const tidy = tidyUp([{ i: "a", x: 0, y: 6, w: 12, h: 4, minW: 3 }, { i: "b", x: 12, y: 30, w: 12, h: 8 }]);
    expect(tidy).toEqual([{ i: "a", x: 0, y: 0, w: 12, h: 4, minW: 3 }, { i: "b", x: 12, y: 0, w: 12, h: 8 }]);
  });
});

function mountGrid(items: GridItem[]) {
  render(
    <DashboardGrid items={items} editing onLayoutChange={vi.fn()}>
      {items.map((it) => (
        <div key={it.i}>{it.i}</div>
      ))}
    </DashboardGrid>,
  );
  if (!grid) throw new Error("the grid didn't render");
  return grid;
}

/** The layout during a drag: the dragged tile at (x, y). */
const dragged = (items: GridItem[], id: string, x: number, y: number): LayoutItem[] => items.map((t) => (t.i === id ? { ...t, x, y } : { ...t }));

describe("DashboardGrid: free placement", () => {
  it("doesn't pull tiles up: nothing compacts the layout (gaps and empty space stay)", () => {
    const props = mountGrid([...AROUND, MOVER]);
    expect((props.compactor as { type: unknown }).type).toBeNull();
    const low = [{ i: "a", x: 0, y: 30, w: 6, h: 10 }, { i: "b", x: 6, y: 12, w: 6, h: 4 }];
    expect((props.compactor as ReturnType<typeof freeCompactor>).compact(low, 24)).toEqual(low);
    // A stored layout is shown exactly as stored.
    expect(pushDown([...AROUND, MOVER])).toEqual([...AROUND, MOVER]);
  });

  it("never overlaps: a tile in the way moves down, out of it", () => {
    // What a drag runs: drop "m" onto "left", then the grid's compactor.
    const layout = [...AROUND, MOVER].map((t) => ({ ...t }));
    const m = layout.find((t) => t.i === "m")!;
    const moved = freeCompactor(() => "m").compact(moveElement(layout, m, 2, 6, true, false, null, 24, false), 24);
    noOverlaps(moved);
    // "m" takes the spot (react-grid-layout lines it up with the top of the tile it lands
    // on); "left" moves just below it, and "bottom" below that one.
    const at = (id: string) => moved.find((t) => t.i === id)!;
    expect(at("m")).toMatchObject({ x: 2, y: 4 });
    expect(at("left").y).toBe(at("m").y + at("m").h);
    expect(at("bottom").y).toBe(at("left").y + at("left").h);
    // Tiles nowhere near stay where they are.
    expect(moved.find((t) => t.i === "right")).toMatchObject({ x: 20, y: 4 });
  });

  it("shows the final size in the dashed outline while dragging into a gap", () => {
    const props = mountGrid([...AROUND, MOVER]);
    const placeholder: LayoutItem = { i: "m", x: 10, y: 6, w: 6, h: 10 };
    props.onDrag(dragged([...AROUND, MOVER], "m", 10, 6), MOVER, { ...MOVER }, placeholder);
    expect(placeholder).toMatchObject({ x: 8, y: 4, w: 12, h: 20 });
  });

  it("fills the gap on release (the grid then eases the tile into it)", () => {
    const props = mountGrid([...AROUND, MOVER]);
    const final = dragged([...AROUND, MOVER], "m", 10, 6);
    props.onDragStop(final, MOVER, { ...MOVER }, null);
    expect(final.find((t) => t.i === "m")).toEqual({ i: "m", x: 8, y: 4, w: 12, h: 20, minW: 6, minH: 10 });
    noOverlaps(final);
  });

  it("leaves the tile alone in open space, when it didn't move, or below its minimum", () => {
    const props = mountGrid([...AROUND, MOVER]);
    const open = dragged([...AROUND, MOVER], "m", 4, 38);
    props.onDragStop(open, MOVER, { ...MOVER }, null);
    expect(open.find((t) => t.i === "m")).toMatchObject({ x: 4, y: 38, w: 6, h: 10 });
    const still = dragged([...AROUND, MOVER], "m", 0, 28);
    props.onDragStop(still, MOVER, { ...MOVER }, null);
    expect(still.find((t) => t.i === "m")).toMatchObject({ x: 0, y: 28, w: 6, h: 10 });
    const big = { ...MOVER, minW: 14 };
    const props2 = mountGrid([...AROUND, big]);
    const small = dragged([...AROUND, big], "m", 10, 6);
    props2.onDragStop(small, big, { ...big }, null);
    expect(small.find((t) => t.i === "m")).toMatchObject({ x: 10, y: 6, w: 6, h: 10 });
  });
});
