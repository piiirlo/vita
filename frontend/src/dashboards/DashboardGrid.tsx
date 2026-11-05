import type { ReactNode } from "react";
import ReactGridLayout, { useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { GRID_COLUMNS, GRID_MARGIN, ROW_HEIGHT, type GridItem } from "./layout.ts";

type Props = {
  items: GridItem[];
  editing: boolean;
  onLayoutChange(items: readonly GridItem[]): void;
  /** One element per item, keyed by the item id. */
  children: ReactNode;
};

/** The 12-column dashboard grid. Tiles move and resize only in edit mode (by the header). */
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
          resizeConfig={{ enabled: editing, handles: ["se", "e", "s"] }}
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
