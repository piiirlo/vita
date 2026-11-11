/** Pivot table layout from grouped rows (the grouping and every total are done in SQL).
 * Pure functions: rows -> header rows, body rows with cells, heat levels, caps. */
import type { ChartDataResult, Dataset, MetricRef } from "../api.ts";
import { metricFormatter } from "./display.ts";
import { toNumber } from "./format.ts";
import { columnLabel, dimensionLabel, metricLabel, metricName, PIVOT_MAX_COLUMNS, type DisplayOptions } from "./model.ts";

export const ROW_LEVEL = "__row_level";
export const COL_LEVEL = "__col_level";
/** Body rows drawn at most (collapse groups or filter to see the rest). */
export const PIVOT_MAX_ROWS_SHOWN = 500;
export const TOTAL_LABEL = "Total";

export type PivotSpec = {
  rows: string[];
  cols: string[];
  metrics: MetricRef[];
  totals: boolean;
  display: DisplayOptions;
  dataset: Dataset | null;
  /** Keys of collapsed row groups / outer column groups. */
  collapsedRows?: ReadonlySet<string>;
  collapsedCols?: ReadonlySet<string>;
};

/** One column of values: a column slot (leaf combination, a group subtotal or the total) x a metric. */
export type PivotColumn = { slot: string; kind: "leaf" | "subtotal" | "total"; metric: string };

export type HeaderCell = { label: string; colSpan: number; rowSpan: number; kind: "dim" | "leaf" | "subtotal" | "total" | "metric" | "corner"; groupKey?: string; collapsed?: boolean };

export type PivotCell = { text: string; value: number | null; heat: number | null };

export type PivotRow = {
  key: string;
  label: string;
  /** 0 = outermost row dimension. */
  depth: number;
  kind: "group" | "leaf" | "total";
  /** Groups only. */
  collapsed?: boolean;
  cells: PivotCell[];
};

export type PivotLayout = {
  header: HeaderCell[][];
  columns: PivotColumn[];
  body: PivotRow[];
  /** Leaf column combinations not shown (over PIVOT_MAX_COLUMNS). */
  hiddenColumns: number;
  totalColumns: number;
  /** Body rows not drawn (over PIVOT_MAX_ROWS_SHOWN). */
  hiddenRows: number;
};

const keyPart = (v: unknown) => (v === null || v === undefined ? "\u0000" : String(v));
export const pathKey = (path: unknown[]) => path.map(keyPart).join("\u0001");

type Record_ = { rowPath: unknown[]; colPath: unknown[]; values: unknown[] };

/** Heat level 1-5 of v between lo and hi (null when there's no spread or no value). */
export function heatLevel(v: number | null, lo: number, hi: number): number | null {
  if (v === null || !(hi > lo)) return null;
  return Math.min(5, Math.max(1, Math.ceil(((v - lo) / (hi - lo)) * 5) || 1));
}

export function pivotLayout(result: ChartDataResult, spec: PivotSpec): PivotLayout {
  const { rows, cols, metrics, totals, display, dataset } = spec;
  const index = (name: string) => result.columns.findIndex((c) => c.name === name);
  const ri = rows.map(index);
  const ci = cols.map(index);
  const rl = index(ROW_LEVEL);
  const cl = index(COL_LEVEL);
  const mi = metrics.map((m) => index(metricName(m)));
  const r = rows.length;
  const c = cols.length;

  // Every SQL row, keyed by (row path, column path); the levels say which dims are grouped.
  const records: Record_[] = result.rows.map((row) => {
    const rowLevel = rl >= 0 ? (toNumber(row[rl]) ?? r) : r;
    const colLevel = cl >= 0 ? (toNumber(row[cl]) ?? c) : c;
    return {
      rowPath: ri.slice(0, rowLevel).map((i) => row[i]),
      colPath: ci.slice(0, colLevel).map((i) => row[i]),
      values: mi.map((i) => row[i]),
    };
  });
  const cell = new Map<string, unknown[]>();
  for (const rec of records) cell.set(`${rec.rowPath.length}:${pathKey(rec.rowPath)}|${rec.colPath.length}:${pathKey(rec.colPath)}`, rec.values);
  const lookup = (rowPath: unknown[], colPath: unknown[]) => cell.get(`${rowPath.length}:${pathKey(rowPath)}|${colPath.length}:${pathKey(colPath)}`);

  // ---- columns: leaf combinations in SQL order, capped; subtotals per outer group; total.
  const leafPaths: unknown[][] = [];
  const seenLeaf = new Set<string>();
  for (const rec of records) {
    if (rec.colPath.length !== c) continue;
    const k = pathKey(rec.colPath);
    if (!seenLeaf.has(k)) {
      seenLeaf.add(k);
      leafPaths.push(rec.colPath);
    }
  }
  const totalColumns = c === 0 ? 1 : leafPaths.length;
  const shownLeaves = c === 0 ? [[]] : leafPaths.slice(0, PIVOT_MAX_COLUMNS);
  const hiddenColumns = Math.max(0, totalColumns - shownLeaves.length);

  type Slot = { path: unknown[]; kind: PivotColumn["kind"]; key: string };
  const slots: Slot[] = [];
  const collapsedCols = spec.collapsedCols ?? new Set<string>();
  const canCollapseCols = totals && c === 2;
  if (c === 2) {
    // Group leaves by their outer value (they come sorted, so groups are contiguous).
    let i = 0;
    while (i < shownLeaves.length) {
      const outer = shownLeaves[i]![0];
      const group: unknown[][] = [];
      while (i < shownLeaves.length && keyPart(shownLeaves[i]![0]) === keyPart(outer)) group.push(shownLeaves[i++]!);
      const groupKey = pathKey([outer]);
      if (!(canCollapseCols && collapsedCols.has(groupKey))) for (const p of group) slots.push({ path: p, kind: "leaf", key: `L${pathKey(p)}` });
      if (totals) slots.push({ path: [outer], kind: "subtotal", key: `S${groupKey}` });
    }
  } else {
    for (const p of shownLeaves) slots.push({ path: p, kind: "leaf", key: `L${pathKey(p)}` });
  }
  if (totals && c >= 1) slots.push({ path: [], kind: "total", key: "T" });

  const columns: PivotColumn[] = slots.flatMap((s) => metrics.map((m) => ({ slot: s.key, kind: s.kind, metric: metricName(m) })));

  // ---- header rows
  const several = metrics.length > 1;
  const header: HeaderCell[][] = [];
  const cornerLabel = rows.map((d) => columnLabel(d, dataset)).join(" › ");
  const headerDepth = Math.max(c, 1) + (several ? 1 : 0);
  const label = (v: unknown, dim: string) => dimensionLabel(v, dim, dataset);
  if (c === 0) {
    header.push([
      { label: cornerLabel, colSpan: 1, rowSpan: headerDepth, kind: "corner" },
      ...(several ? [] : metrics.map((m) => ({ label: metricLabel(m, dataset), colSpan: 1, rowSpan: 1, kind: "metric" as const }))),
    ]);
    if (several) header[0]!.push({ label: "", colSpan: metrics.length, rowSpan: 1, kind: "leaf" });
  } else {
    // Row 0: outer column values (c = 2: spanning their leaves + subtotal) or the values (c = 1).
    const top: HeaderCell[] = [{ label: cornerLabel, colSpan: 1, rowSpan: headerDepth, kind: "corner" }];
    const second: HeaderCell[] = [];
    const m = metrics.length;
    if (c === 1) {
      for (const s of slots) {
        top.push({ label: s.kind === "total" ? TOTAL_LABEL : label(s.path[0], cols[0]!), colSpan: m, rowSpan: 1, kind: s.kind === "total" ? "total" : "leaf" });
      }
    } else {
      let i = 0;
      while (i < slots.length) {
        const s = slots[i]!;
        if (s.kind === "total") {
          top.push({ label: TOTAL_LABEL, colSpan: m, rowSpan: 2, kind: "total" });
          i++;
          continue;
        }
        const outer = s.path[0];
        const groupKey = pathKey([outer]);
        const group: Slot[] = [];
        while (i < slots.length && slots[i]!.kind !== "total" && keyPart(slots[i]!.path[0]) === keyPart(outer)) group.push(slots[i++]!);
        const collapsed = canCollapseCols && collapsedCols.has(groupKey);
        top.push({ label: label(outer, cols[0]!), colSpan: group.length * m, rowSpan: 1, kind: "dim", groupKey: canCollapseCols ? groupKey : undefined, collapsed });
        for (const g of group) {
          second.push({ label: g.kind === "subtotal" ? TOTAL_LABEL : label(g.path[1], cols[1]!), colSpan: m, rowSpan: 1, kind: g.kind });
        }
      }
    }
    header.push(top);
    if (second.length) header.push(second);
  }
  if (several) header.push(slots.flatMap(() => metrics.map((mm) => ({ label: metricLabel(mm, dataset), colSpan: 1, rowSpan: 1, kind: "metric" as const }))));

  // ---- heat scales (leaf cells only)
  const heat = new Set(display.heat ?? []);
  const ranges = metrics.map((m, k) => {
    if (!heat.has(metricName(m))) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const rec of records) {
      if (rec.rowPath.length !== r || rec.colPath.length !== c) continue;
      const v = toNumber(rec.values[k]);
      if (v === null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return Number.isFinite(lo) ? { lo, hi } : null;
  });
  const formats = metrics.map((m) => metricFormatter(display, m, dataset));

  const cellsFor = (rowPath: unknown[] | null): PivotCell[] =>
    slots.flatMap((s) =>
      metrics.map((_, k) => {
        const values = rowPath === null ? undefined : lookup(rowPath, s.path);
        const raw = values?.[k];
        const value = toNumber(raw);
        const range = ranges[k];
        const isLeaf = s.kind === "leaf" && rowPath !== null && rowPath.length === r;
        return {
          text: values === undefined || raw === null || raw === undefined ? "" : formats[k]!(raw),
          value,
          heat: range && isLeaf ? heatLevel(value, range.lo, range.hi) : null,
        };
      }),
    );

  // ---- body: groups (with their SQL subtotals) and leaves, in SQL order; then the total.
  const body: PivotRow[] = [];
  const collapsedRows = spec.collapsedRows ?? new Set<string>();
  if (r === 0) {
    body.push({ key: "total", label: TOTAL_LABEL, depth: 0, kind: "total", cells: cellsFor([]) });
  } else {
    const leafRows: unknown[][] = [];
    const seen = new Set<string>();
    for (const rec of records) {
      if (rec.rowPath.length !== r) continue;
      const k = pathKey(rec.rowPath);
      if (!seen.has(k)) {
        seen.add(k);
        leafRows.push(rec.rowPath);
      }
    }
    const opened = new Set<string>();
    for (const path of leafRows) {
      let hidden = false;
      for (let depth = 0; depth < r - 1; depth++) {
        const prefix = path.slice(0, depth + 1);
        const k = pathKey(prefix);
        if (hidden) break;
        if (!opened.has(`${depth}:${k}`)) {
          opened.add(`${depth}:${k}`);
          const collapsed = collapsedRows.has(k);
          body.push({ key: k, label: label(prefix[depth], rows[depth]!), depth, kind: "group", collapsed, cells: totals ? cellsFor(prefix) : cellsFor(null) });
        }
        if (collapsedRows.has(k)) hidden = true;
      }
      if (!hidden) body.push({ key: pathKey(path), label: label(path[r - 1], rows[r - 1]!), depth: r - 1, kind: "leaf", cells: cellsFor(path) });
    }
    if (totals) body.push({ key: "total", label: TOTAL_LABEL, depth: 0, kind: "total", cells: cellsFor([]) });
  }
  const hiddenRows = Math.max(0, body.length - PIVOT_MAX_ROWS_SHOWN);
  const last = body[body.length - 1];
  const shown = !hiddenRows ? body : last?.kind === "total" ? [...body.slice(0, PIVOT_MAX_ROWS_SHOWN - 1), last] : body.slice(0, PIVOT_MAX_ROWS_SHOWN);
  return { header, columns, body: shown, hiddenColumns, totalColumns, hiddenRows };
}
