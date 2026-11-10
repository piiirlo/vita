/** Schema diagram: auto-layout with dagre, search and neighbors. Pure (unit-tested). */
import { Graph, layout } from "@dagrejs/dagre";
import type { DbType, SchemaDiagram } from "../api.ts";

export const CARD_WIDTH = 230;
const HEADER_HEIGHT = 40;
const SUMMARY_HEIGHT = 28;
const ROW_HEIGHT = 22;
/** An expanded card lists at most this many columns ("+ N more"). */
export const MAX_SHOWN_COLUMNS = 16;

export type NodeBox = { name: string; x: number; y: number; width: number; height: number };
export type EdgeLine = { id: string; from: string; to: string; points: { x: number; y: number }[]; label: string };
export type DiagramLayout = { nodes: Map<string, NodeBox>; edges: EdgeLine[]; width: number; height: number };

/** Card height: a header, then a one-line summary (collapsed) or the columns (expanded). */
export function cardHeight(columns: number, expanded: boolean): number {
  if (!expanded) return HEADER_HEIGHT + SUMMARY_HEIGHT;
  const shown = Math.min(columns, MAX_SHOWN_COLUMNS) + (columns > MAX_SHOWN_COLUMNS ? 1 : 0);
  return HEADER_HEIGHT + Math.max(1, shown) * ROW_HEIGHT + 10;
}

/** Lay tables out left to right along their foreign keys (tables without keys go in rows
 * below, so a big schema doesn't become one endless column). */
export function layoutDiagram(diagram: SchemaDiagram, expanded: ReadonlySet<string>): DiagramLayout {
  // A multigraph: two foreign keys between the same tables are two lines.
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 90, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const names = new Set(diagram.tables.map((t) => t.name));
  const linked = new Set<string>();
  for (const fk of diagram.foreign_keys) {
    if (fk.referred_schema === diagram.schema_name && names.has(fk.referred_table) && names.has(fk.table)) {
      linked.add(fk.table);
      linked.add(fk.referred_table);
    }
  }
  for (const t of diagram.tables) {
    if (linked.has(t.name)) g.setNode(t.name, { width: CARD_WIDTH, height: cardHeight(t.columns.length, expanded.has(t.name)) });
  }
  const edges: EdgeLine[] = [];
  diagram.foreign_keys.forEach((fk, i) => {
    if (!linked.has(fk.table) || !linked.has(fk.referred_table) || fk.referred_schema !== diagram.schema_name) return;
    const id = `fk${i}`;
    // Referenced table on the left, the table holding the key on the right.
    g.setEdge(fk.referred_table, fk.table, {}, id);
    edges.push({ id, from: fk.table, to: fk.referred_table, points: [], label: `${fk.table}.${fk.columns.join(", ")} → ${fk.referred_table}.${fk.referred_columns.join(", ")}` });
  });
  if (g.nodeCount() > 0) layout(g);

  const nodes = new Map<string, NodeBox>();
  let width = 0;
  let height = 0;
  for (const name of g.nodes()) {
    const n = g.node(name) as { x: number; y: number; width: number; height: number };
    nodes.set(name, { name, x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height });
    width = Math.max(width, n.x + n.width / 2);
    height = Math.max(height, n.y + n.height / 2);
  }
  for (const e of edges) {
    const fk = g.outEdges(e.to)?.find((edge) => edge.name === e.id);
    const points = fk ? (g.edge(fk) as { points?: { x: number; y: number }[] }).points : undefined;
    e.points = points ?? [];
  }

  // Tables without foreign keys: a grid below the connected ones.
  const loose = diagram.tables.filter((t) => !linked.has(t.name));
  const perRow = Math.max(4, Math.floor(Math.max(width, 1100) / (CARD_WIDTH + 28)));
  let rowTop = height + (nodes.size ? 48 : 24);
  for (let i = 0; i < loose.length; i += perRow) {
    const row = loose.slice(i, i + perRow);
    const rowHeight = Math.max(...row.map((t) => cardHeight(t.columns.length, expanded.has(t.name))));
    row.forEach((t, j) => {
      nodes.set(t.name, {
        name: t.name,
        x: 24 + j * (CARD_WIDTH + 28),
        y: rowTop,
        width: CARD_WIDTH,
        height: cardHeight(t.columns.length, expanded.has(t.name)),
      });
    });
    width = Math.max(width, 24 + row.length * (CARD_WIDTH + 28));
    rowTop += rowHeight + 28;
  }
  height = Math.max(height, rowTop);
  return { nodes, edges, width: width + 24, height: height + 24 };
}

/** Tables linked to `table` by a foreign key (either way). */
export function neighbors(diagram: SchemaDiagram, table: string): Set<string> {
  const result = new Set<string>();
  for (const fk of diagram.foreign_keys) {
    if (fk.referred_schema !== diagram.schema_name) continue;
    if (fk.table === table) result.add(fk.referred_table);
    if (fk.referred_table === table) result.add(fk.table);
  }
  result.delete(table);
  return result;
}

/** Tables whose name contains the search (case-insensitive), best (prefix) matches first. */
export function searchTables(diagram: SchemaDiagram, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return diagram.tables
    .map((t) => t.name)
    .filter((n) => n.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) || a.localeCompare(b));
}

/** A quoted identifier for the connection's database. */
export function quoteIdentifier(name: string, dbType: DbType): string {
  return dbType === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** SELECT * of a table (for Preview and "Open in SQL Lab"). */
export function selectAllSql(schema: string, table: string, dbType: DbType, limit = 100): string {
  return `SELECT *\nFROM ${quoteIdentifier(schema, dbType)}.${quoteIdentifier(table, dbType)}\nLIMIT ${limit}`;
}

/** The transform that centers `box` in a viewport of `view` size at `scale`. */
export function centerOn(box: { x: number; y: number; width: number; height: number }, view: { width: number; height: number }, scale: number) {
  return {
    x: view.width / 2 - (box.x + box.width / 2) * scale,
    y: view.height / 2 - (box.y + box.height / 2) * scale,
    scale,
  };
}

/** The transform that fits the whole diagram in the viewport (never zooming in past 1). */
export function fitAll(size: { width: number; height: number }, view: { width: number; height: number }) {
  const scale = Math.max(0.15, Math.min(1, (view.width - 32) / size.width, (view.height - 32) / size.height));
  return { x: (view.width - size.width * scale) / 2, y: Math.max(16, (view.height - size.height * scale) / 2), scale };
}
