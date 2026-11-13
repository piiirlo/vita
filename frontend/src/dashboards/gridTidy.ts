/** "Tidy up": pull every tile up as far as it goes (react-grid-layout's own vertical
 * compaction, which dashboards always used before tiles could be placed freely). Kept out of
 * layout.ts so react-grid-layout stays in the dashboard page's chunk. */
import { verticalCompactor } from "react-grid-layout";
import { GRID_COLUMNS, type GridItem } from "./layout.ts";

export function tidyUp(items: readonly GridItem[]): GridItem[] {
  const compacted = verticalCompactor.compact(items.map((i) => ({ ...i })), GRID_COLUMNS);
  return compacted.map(({ i, x, y, w, h, minW, minH }) => ({ i, x, y, w, h, ...(minW !== undefined ? { minW } : {}), ...(minH !== undefined ? { minH } : {}) }));
}
