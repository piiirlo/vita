/** How the dashboard grid keeps tiles apart (Part 13): tiles stay where they are put (never
 * pulled up); a tile overlapping another moves down just below it, cascading. The tile being
 * dragged or resized has priority: it stays where the pointer puts it and the others move out
 * of its way. Kept out of layout.ts so react-grid-layout stays in the dashboard page's chunk. */
import type { Compactor, Layout, LayoutItem } from "react-grid-layout";

const collides = (a: LayoutItem, b: LayoutItem) =>
  a.i !== b.i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Every tile at its place or lower: the priority tile first, then in row and column order;
 * a tile overlapping one placed before it moves down just below it (until it overlaps
 * nothing). Same order out; a layout without overlaps comes back unchanged. */
export function pushDown(layout: Layout, priority: string | null = null): LayoutItem[] {
  const items = layout.map((l) => ({ ...l }));
  const order = [...items].sort((a, b) => Number(b.i === priority) - Number(a.i === priority) || a.y - b.y || a.x - b.x);
  const placed: LayoutItem[] = [];
  for (const item of order) {
    let hit = placed.find((p) => collides(p, item));
    while (hit) {
      item.y = hit.y + hit.h;
      hit = placed.find((p) => collides(p, item));
    }
    placed.push(item);
  }
  return items;
}

/** The grid's compactor; `active()` names the tile being dragged or resized (or null). No
 * compaction type: react-grid-layout doesn't move or compact anything itself. */
export function freeCompactor(active: () => string | null): Compactor {
  return { type: null, allowOverlap: false, compact: (layout) => pushDown(layout, active()) };
}
