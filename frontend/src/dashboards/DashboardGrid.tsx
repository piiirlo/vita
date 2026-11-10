import type { ReactNode } from "react";
import ReactGridLayout, { useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import { GRID_COLUMNS, GRID_MARGIN, RESIZE_HANDLES, ROW_HEIGHT, type GridItem } from "./layout.ts";

type Props = {
  items: GridItem[];
  editing: boolean;
  onLayoutChange(items: readonly GridItem[]): void;
  /** One element per item, keyed by the item id. */
  children: ReactNode;
};

/** The 24-column dashboard grid. Tiles move (by the header) and resize (from any edge or
 * corner, down to a minimum size per chart type) only in edit mode. While resizing the tile
 * follows the pointer and a dashed outline shows where it will snap; charts redraw once the
 * size settles (see ChartView / EChart), not on every pointer move. */
export default function DashboardGrid({ items, editing, onLayoutChange, children }: Props) {
  const { width, containerRef, mounted } = useContainerWidth();

  return (
    <div ref={containerRef} className={`dash-grid${editing ? " editing" : ""}`}>
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={items}
          gridConfig={{ cols: GRID_COLUMNS, rowHeight: ROW_HEIGHT, margin: [GRID_MARGIN, GRID_MARGIN], containerPadding: [0, 0] }}
          dragConfig={{ enabled: editing, handle: ".dash-drag-handle", cancel: "button, input, textarea, a, select" }}
          resizeConfig={{ enabled: editing, handles: [...RESIZE_HANDLES] }}
          compactor={verticalCompactor}
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
