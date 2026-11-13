/** The chart editor's Data panel, in the order people think: what to measure, what to break
 * it down by, over time, filters, then sort & limit. Which sections a chart type uses, the
 * one-line hint of an empty section, and what dropping a column on a section does. Pure. */
import type { ChartQuery, Dataset, DatasetColumn, MetricRef, VizType } from "../api.ts";
import { defaultGrain, metricName, PIVOT_MAX_COLUMN_DIMENSIONS, PIVOT_MAX_ROW_DIMENSIONS, temporalColumns, type ChartState } from "./model.ts";

export type SectionId = "measure" | "breakdown" | "time" | "filter" | "sort";

export const SECTION_TITLES: Record<SectionId, string> = {
  measure: "What to measure",
  breakdown: "Break it down by",
  time: "Over time",
  filter: "Filter",
  sort: "Sort & limit",
};

/** Chart types that show one total: nothing to break down. */
const NO_BREAKDOWN = new Set<VizType>(["big_number", "gauge"]);

/** The sections a chart uses, in order. "Over time" needs a time column in the dataset. */
export function sectionsFor(state: ChartState, dataset: Dataset): SectionId[] {
  const out: SectionId[] = ["measure"];
  if (!NO_BREAKDOWN.has(state.vizType) && !isRaw(state)) out.push("breakdown");
  if (temporalColumns(dataset).length > 0) out.push("time");
  out.push("filter", "sort");
  return out;
}

export const isRaw = (state: ChartState) => state.vizType === "table" && state.display.mode === "raw";

const BREAKDOWN_HINTS: Partial<Record<VizType, string>> = {
  table: "Add columns to group the rows by, or leave it empty for one total row.",
  bar: "Pick what each bar stands for: a category, or time.",
  combo: "Pick the x axis: a category, or time.",
  line: "Pick the x axis: time, or ordered categories.",
  area: "Pick the x axis: time, or ordered categories.",
  pie: "Pick what the slices are, e.g. a category column.",
  treemap: "Pick what the boxes are (and maybe what's inside them).",
  funnel: "Pick the steps of the funnel.",
  pivot_table: "Add row and column dimensions.",
  heatmap: "Pick the heatmap's rows and columns.",
  scatter: "Pick what each point is.",
  histogram: "Pick a number column to cut into bins.",
  world_map: "Pick the column with the countries.",
};

/** The one-line hint of an empty section (null: it isn't empty). */
export function emptyHint(section: SectionId, state: ChartState): string | null {
  const { query, vizType } = state;
  switch (section) {
    case "measure":
      if (isRaw(state)) return query.columns.length ? null : "Pick the columns to list.";
      return query.metrics.length ? null : "Pick what to count or add up: Count, or the sum of a number column.";
    case "breakdown": {
      const grain = query.time?.grain ?? null;
      const filled =
        vizType === "histogram"
          ? Boolean(query.bins?.column)
          : query.dimensions.length > 0 || (query.column_dimensions ?? []).length > 0 || Boolean(grain && ["bar", "combo", "line", "area", "table"].includes(vizType));
      return filled ? null : (BREAKDOWN_HINTS[vizType] ?? null);
    }
    case "time":
      return query.time?.grain || (query.time && query.time.range.kind !== "none") ? null : "All of the data. Pick a time range to narrow it down.";
    case "filter":
      return query.filters.length ? null : "No filters: every row counts.";
    case "sort":
      return null;
  }
}

// ---------- dropping a column on a section ----------

export type DropResult = { patch: Partial<ChartQuery> } | { refused: string };

const label = (c: DatasetColumn) => c.label || c.name;

/** What a column becomes as a metric: the sum of a number (not an identifier), else the
 * count of distinct values. */
export function metricForColumn(c: DatasetColumn): MetricRef {
  if (c.effective_type === "number" && !c.is_identifier) return { column: c.name, aggregate: "SUM" };
  return { column: c.name, aggregate: "COUNT_DISTINCT" };
}

const SINGLE_METRIC = new Set<VizType>(["big_number", "gauge", "pie", "treemap", "funnel", "heatmap", "histogram", "world_map"]);

function timeTo(query: ChartQuery, column: DatasetColumn, withGrain: boolean): ChartQuery["time"] {
  return {
    column: column.name,
    grain: withGrain ? (query.time?.column === column.name && query.time.grain ? query.time.grain : defaultGrain(column)) : (query.time?.grain ?? null),
    range: query.time?.range ?? { kind: "none" },
  };
}

/** Drop the column `name` on `section`: the query change, or why it can't go there. */
export function dropColumn(state: ChartState, dataset: Dataset, section: SectionId, name: string): DropResult {
  const { query, vizType } = state;
  const col = dataset.columns.find((c) => c.name === name && !c.is_missing && !c.is_hidden);
  if (!col) return { refused: `“${name}” isn't a column of this dataset.` };

  if (section === "measure") {
    if (isRaw(state)) return query.columns.includes(name) ? { refused: `“${label(col)}” is already listed.` } : { patch: { columns: [...query.columns, name] } };
    if (vizType === "histogram") return { refused: "A histogram measures rows per bin: drop the column on “Break it down by”." };
    const ref = metricForColumn(col);
    if (vizType === "scatter") {
      const metrics = [...query.metrics];
      if (metrics.length < 3) metrics.push(ref);
      else metrics[1] = ref;
      return { patch: { metrics } };
    }
    if (SINGLE_METRIC.has(vizType)) return { patch: { metrics: [ref] } };
    if (query.metrics.some((m) => metricName(m) === metricName(ref))) return { refused: `${label(col)} is already measured.` };
    return { patch: { metrics: [...query.metrics, ref] } };
  }

  if (section === "filter") {
    const operator = col.effective_type === "boolean" || col.effective_type === "other" ? "IS NOT NULL" : "=";
    return { patch: { filters: [...query.filters, { column: name, operator, value: operator === "=" ? "" : null }] } };
  }

  if (section === "time") {
    if (!col.is_temporal) return { refused: `“${label(col)}” isn't a time column. Mark it as time in the dataset's Columns tab.` };
    return { patch: { time: timeTo(query, col, false) } };
  }

  if (section === "sort") {
    return { patch: { order_by: { by: name, descending: query.order_by?.descending ?? true } } };
  }

  // ---- breakdown ----
  const groupable = col.is_dimension || col.is_temporal;
  const isCategory = groupable && !col.is_temporal;
  const notGroupable: DropResult = {
    refused: `“${label(col)}” can't be used to group by. Mark it as a dimension in the dataset's Columns tab.`,
  };
  const grain = query.time?.grain ?? null;
  switch (vizType) {
    case "table":
      if (!groupable) return notGroupable;
      if (query.dimensions.includes(name)) return { refused: `Already grouped by ${label(col)}.` };
      return { patch: { dimensions: [...query.dimensions, name] } };
    case "bar":
    case "combo":
    case "line":
    case "area": {
      if (col.is_temporal) return { patch: { dimensions: [], time: timeTo(query, col, true) } };
      if (!groupable) return notGroupable;
      const xEmpty = !grain && query.dimensions.length === 0;
      // The x axis first; then (bar / line / area) the series.
      if (xEmpty || vizType === "combo") return { patch: { dimensions: [name], series: query.series === name ? null : query.series } };
      if (query.dimensions[0] === name) return { refused: `${label(col)} is already the x axis.` };
      return { patch: { series: name } };
    }
    case "pie":
    case "funnel":
    case "world_map":
      if (!isCategory) return col.is_temporal ? { refused: `Pick a category for this chart, not a time column.` } : notGroupable;
      return { patch: { dimensions: [name] } };
    case "treemap": {
      if (!isCategory) return notGroupable;
      const dims = query.dimensions.filter((d) => d !== name);
      return { patch: { dimensions: dims.length === 0 ? [name] : [dims[0]!, name] } };
    }
    case "pivot_table": {
      if (!groupable) return notGroupable;
      const rows = query.dimensions;
      const cols = query.column_dimensions ?? [];
      if (rows.includes(name) || cols.includes(name)) return { refused: `${label(col)} is already in the table.` };
      if (rows.length < PIVOT_MAX_ROW_DIMENSIONS) return { patch: { dimensions: [...rows, name] } };
      if (cols.length < PIVOT_MAX_COLUMN_DIMENSIONS) return { patch: { column_dimensions: [...cols, name] } };
      return { refused: "The pivot table is full: remove a row or column dimension first." };
    }
    case "heatmap": {
      if (!groupable) return notGroupable;
      const rows = query.dimensions[0];
      if (!rows) return { patch: { dimensions: [name] } };
      if (rows === name) return { refused: `${label(col)} is already the rows.` };
      return { patch: { dimensions: [rows, name] } };
    }
    case "scatter":
      if (!groupable) return notGroupable;
      if (query.dimensions.length === 0) return { patch: { dimensions: [name] } };
      return isCategory && query.dimensions[0] !== name ? { patch: { series: name } } : { patch: { dimensions: [name] } };
    case "histogram":
      if (col.effective_type !== "number") return { refused: `A histogram bins numbers; “${label(col)}” isn't a number column.` };
      return { patch: { bins: { ...(query.bins ?? { count: 20 }), column: name } } };
    default:
      return { refused: "This chart has nothing to break down." };
  }
}

/** The sections a column can be dropped on (for the column list's "Add to…" menu). */
export function targetsFor(state: ChartState, dataset: Dataset, name: string): SectionId[] {
  return sectionsFor(state, dataset).filter((s) => s !== "sort" && "patch" in dropColumn(state, dataset, s, name));
}

/** Columns for the palette: usable ones, matching a search on name or label. */
export function paletteColumns(dataset: Dataset, search: string): DatasetColumn[] {
  const q = search.trim().toLowerCase();
  return dataset.columns.filter((c) => !c.is_missing && !c.is_hidden && (!q || c.name.toLowerCase().includes(q) || (c.label ?? "").toLowerCase().includes(q)));
}
