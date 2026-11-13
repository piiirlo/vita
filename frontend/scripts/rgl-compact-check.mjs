// Prints react-grid-layout's own vertical compaction of a few layouts as JSON, to check the
// backend's port (app/dashboard_grid.py compact_vertical, migration 0013) against it.
// Run: docker compose exec frontend node scripts/rgl-compact-check.mjs
import { verticalCompactor } from "react-grid-layout";

const cases = {
  gap_above: [{ i: "a", x: 0, y: 5, w: 12, h: 4 }],
  stacked: [
    { i: "t", x: 0, y: 0, w: 24, h: 3 },
    { i: "a", x: 0, y: 10, w: 12, h: 16 },
    { i: "b", x: 12, y: 30, w: 12, h: 16 },
  ],
  pushed: [
    { i: "a", x: 0, y: 0, w: 12, h: 8 },
    { i: "b", x: 6, y: 4, w: 12, h: 8 },
    { i: "c", x: 0, y: 2, w: 6, h: 4 },
  ],
  side_by_side: [
    { i: "a", x: 12, y: 7, w: 12, h: 10 },
    { i: "b", x: 0, y: 7, w: 12, h: 20 },
    { i: "c", x: 0, y: 40, w: 24, h: 4 },
  ],
  out_of_order: [
    { i: "c", x: 6, y: 20, w: 6, h: 6 },
    { i: "a", x: 0, y: 0, w: 8, h: 6 },
    { i: "b", x: 4, y: 3, w: 8, h: 6 },
  ],
};

const out = {};
for (const [name, layout] of Object.entries(cases)) {
  out[name] = verticalCompactor.compact(layout.map((l) => ({ ...l })), 24).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
}
console.log(JSON.stringify(out));
