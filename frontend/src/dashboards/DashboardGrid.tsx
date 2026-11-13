import { useMemo, useRef, type ReactNode } from "react";
import ReactGridLayout, { useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import { freeCompactor } from "./compactor.ts";
import { fitToGap, GRID_COLUMNS, GRID_MARGIN, RESIZE_HANDLES, ROW_HEIGHT, type GridItem } from "./layout.ts";

type Props = {
  items: GridItem[];
  editing: boolean;
  onLayoutChange(items: readonly GridItem[]): void;
  /** One element per item, keyed by the item id. */
  children: ReactNode;
};

/** The 24-column dashboard grid. Tiles move (by the header) and resize (from any edge or
 * corner, down to a minimum size per chart type) only in edit mode.
 *
 * Tiles go anywhere, gaps and empty space included, and stay there: nothing pulls them up
 * (no compaction; "Tidy up" does it on demand). Tiles never overlap: one in the way moves
 * down, smoothly. Dropped into a gap, a tile fills it (within its minimum size); the dashed
 * outline shows that final size before the release. While resizing, the tile follows the
 * pointer and the dashed outline shows where it will snap; charts redraw once the size
 * settles (see ChartView / EChart), not on every pointer move. */
export default function DashboardGrid({ items, editing, onLayoutChange, children }: Props) {
  const { width, containerRef, mounted } = useContainerWidth();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // The tile being dragged or resized: it stays where the pointer puts it, others move away.
  const active = useRef<string | null>(null);
  const compactor = useMemo(() => freeCompactor(() => active.current), []);
  const minOf = (id: string) => {
    const item = itemsRef.current.find((t) => t.i === id);
    return { w: item?.minW ?? 1, h: item?.minH ?? 1 };
  };
  /** The dragged tile's auto-fit, if it moved and landed in a gap. */
  const fitFor = (layout: Layout, oldItem: LayoutItem | null, id: string) => {
    const now = layout.find((l) => l.i === id);
    if (!now || !oldItem || (now.x === oldItem.x && now.y === oldItem.y)) return null;
    return fitToGap(layout, id, { x: now.x, y: now.y, w: oldItem.w, h: oldItem.h }, minOf(id));
  };

  return (
    <div ref={containerRef} className={`dash-grid${editing ? " editing" : ""}`}>
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={items}
          gridConfig={{ cols: GRID_COLUMNS, rowHeight: ROW_HEIGHT, margin: [GRID_MARGIN, GRID_MARGIN], containerPadding: [0, 0] }}
          dragConfig={{ enabled: editing, handle: ".dash-drag-handle", cancel: "button, input, textarea, a, select" }}
          resizeConfig={{ enabled: editing, handles: [...RESIZE_HANDLES] }}
          compactor={compactor}
          onDragStart={(_layout, _old, item) => {
            active.current = item?.i ?? null;
          }}
          onResizeStart={(_layout, _old, item) => {
            active.current = item?.i ?? null;
          }}
          onResizeStop={() => {
            active.current = null;
          }}
          onDrag={(layout, oldItem, newItem, placeholder) => {
            // The dashed outline shows the size the tile will get on release.
            if (!newItem || !placeholder) return;
            const fit = fitFor(layout, oldItem, newItem.i);
            if (fit) Object.assign(placeholder, fit);
          }}
          onDragStop={(layout, oldItem, newItem) => {
            active.current = null;
            if (!newItem) return;
            const fit = fitFor(layout, oldItem, newItem.i);
            const dropped = layout.find((l) => l.i === newItem.i);
            // The final layout is what the grid keeps (and reports): it eases into the gap.
            if (fit && dropped) Object.assign(dropped, fit);
          }}
          onLayoutChange={(layout: Layout) => {
            if (editing) onLayoutChange(layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })));
          }}
        >
          {children}
        </ReactGridLayout>
      )}
    </div>
  );
}
