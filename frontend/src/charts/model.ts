/** Chart editor state, what each chart type needs, and the requests to send. Pure functions. */
import type {
  AdhocMetric,
  ChartFilter,
  ChartParams,
  ChartQuery,
  Dataset,
  DatasetColumn,
  Grain,
  MetricRef,
  VizType,
} from "../api.ts";
import type { FormatSpec } from "./display.ts";
import { categoryLabel } from "./format.ts";
import { vizLabel } from "./vizTypes.ts";
import { PART_LABELS, isGrain, partValueLabel, splitDim } from "./dimensions.ts";

export type DisplayOptions = {
  /** Table: grouped rows (default) or raw records. (Changes the query.) */
  mode?: "aggregate" | "raw";

  // ---- every chart (the "Customize" tab) ----
  /** Shown instead of the chart's name as its title (tiles, editor preview). */
  title?: string;
  /** Number format per metric name; wins over the metric's own format. */
  formats?: Record<string, FormatSpec>;
  /** Value-axis title (default on). */
  axis_titles?: boolean;
  legend?: "top" | "bottom" | "right" | "none";
  value_labels?: boolean;

  // ---- bar / line ----
  stacked?: boolean;
  horizontal?: boolean;
  /** Bar order (category axis only). */
  sort?: "value" | "label";
  /** Order of the series (legend, colors). */
  series_sort?: "default" | "value" | "label";
  /** A single color (1-10 = --series-N) instead of the palette; one series only. */
  color?: number | null;
  /** Legend names: original series name -> shown name (e.g. "1" -> "Lethbridge"). */
  series_labels?: Record<string, string>;
  show_points?: boolean;

  // ---- pie ----
  /** A ring with the total in the middle. (Changes the query: one more request for the total.) */
  donut?: boolean;

  // ---- area ----
  /** Not stacked (default), stacked, or 100% stacked (shares of each period, in the browser). */
  stack?: "none" | "stacked" | "percent";

  // ---- combo ----
  /** Per metric name: drawn as bars or a line, on the left or right axis. Default: the first
   * metric is bars on the left, the others lines on the left. */
  combo?: Record<string, ComboSeries>;

  // ---- funnel ----
  /** Steps by value (largest first, default) or in the order of `funnel_steps`. */
  funnel_order?: "value" | "custom";
  /** Step values (as text) in the chosen order; steps not listed follow by value. */
  funnel_steps?: string[];

  // ---- gauge ----
  gauge_min?: number | null;
  /** Empty: a round number above the value (and target). */
  gauge_max?: number | null;
  gauge_target?: number | null;
  /** Colored bands, each up to a value, ascending. The rest of the arc stays neutral. */
  gauge_bands?: GaugeBand[];

  // ---- pivot table ----
  /** Metric names whose cells get a heat scale (lighter = lower). */
  heat?: string[];

  // ---- big number ----
  subtitle?: string;
  font_size?: "auto" | "s" | "m" | "l";
  /** Conditional color: below -> danger, above -> success (either may be empty). */
  color_below?: number | null;
  color_above?: number | null;
  /** +/- % against the period before the time range. (Changes the query: one more request.) */
  compare_previous?: boolean;
  /** (Changes the query: the trend request.) */
  show_trend?: boolean;
  /** First / last date under the trend line. */
  trend_dates?: boolean;

  // ---- data freshness (Data tab; not a look option, but needs no new query either) ----
  /** Chart-data cache lifetime in seconds (0 = off); undefined = the default (10 min). */
  cache_ttl?: number | null;
};

export type ComboSeries = { type: "bar" | "line"; axis: "left" | "right" };
export type GaugeTone = "danger" | "warning" | "success";
export type GaugeBand = { to: number; tone: GaugeTone };

export type ChartState = { vizType: VizType; query: ChartQuery; display: DisplayOptions };

/** Top slices of a new pie (the rest is grouped into "Other"). */
export const PIE_DEFAULT_SLICES = 6;
/** More slices than this are hard to read. */
export const PIE_MAX_READABLE = 7;

/** Treemap: the biggest outer boxes kept (the rest is one "Other" box). */
export const TREEMAP_DEFAULT_TOP = 10;
/** Funnels: at most this many steps (rows). */
export const FUNNEL_MAX_STEPS = 30;
/** Pivot tables: dimensions per side (the backend checks the same) and columns shown. */
export const PIVOT_MAX_ROW_DIMENSIONS = 3;
export const PIVOT_MAX_COLUMN_DIMENSIONS = 2;
export const PIVOT_MAX_COLUMNS = 50;
/** Pivot rows include every subtotal level: a bigger default row limit. */
export const PIVOT_ROW_LIMIT = 10_000;
/** Scatter plots: at most this many points by default (a notice says when there are more). */
export const SCATTER_MAX_POINTS = 5000;
export const DEFAULT_BINS = 20;

export const GRAINS: { value: Grain; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

// ---------- names and labels ----------

export function metricName(ref: MetricRef): string {
  return typeof ref === "string" ? ref : ref.label || `${ref.aggregate}(${ref.column})`;
}

const AGGREGATE_LABELS: Record<AdhocMetric["aggregate"], string> = {
  SUM: "Sum of",
  AVG: "Average",
  MIN: "Min",
  MAX: "Max",
  COUNT: "Count of",
  COUNT_DISTINCT: "Distinct",
};

/** A column's label; a date bucket / time part reads "Order date · by month". */
export function columnLabel(name: string, dataset: Dataset | null): string {
  const { column, part } = splitDim(name, dataset);
  const col = dataset?.columns.find((c) => c.name === column);
  const label = col?.label || column;
  return part ? `${label} · ${PART_LABELS[part]}` : label;
}

export function metricLabel(ref: MetricRef, dataset: Dataset | null): string {
  if (typeof ref === "string") {
    const saved = dataset?.metrics.find((m) => m.name === ref);
    return saved?.label || ref;
  }
  if (ref.label) return ref.label;
  return `${AGGREGATE_LABELS[ref.aggregate]} ${columnLabel(ref.column, dataset)}`;
}

/** The saved metric's number format (ad-hoc metrics have none). */
export function metricFormat(ref: MetricRef, dataset: Dataset | null): string | null {
  if (typeof ref !== "string") return null;
  return dataset?.metrics.find((m) => m.name === ref)?.number_format ?? null;
}

/** Label for any output column of a result: metric, dimension or time column. */
export function outputLabel(name: string, query: ChartQuery, dataset: Dataset | null): string {
  const metric = query.metrics.find((m) => metricName(m) === name);
  return metric ? metricLabel(metric, dataset) : columnLabel(name, dataset);
}

// ---------- which columns fit where ----------

const usable = (c: DatasetColumn) => !c.is_hidden && !c.is_missing;
export const groupableColumns = (d: Dataset) => d.columns.filter((c) => usable(c) && (c.is_dimension || c.is_temporal));
export const temporalColumns = (d: Dataset) => d.columns.filter((c) => usable(c) && c.is_temporal);
export const usableColumns = (d: Dataset) => d.columns.filter(usable);

// ---------- defaults and switching chart type ----------

export function defaultQuery(dataset: Dataset): ChartQuery {
  return {
    dataset_id: dataset.id,
    metrics: ["count"],
    dimensions: [],
    series: null,
    columns: [],
    time: dataset.main_time_column
      ? { column: dataset.main_time_column, grain: null, range: { kind: "none" } }
      : null,
    filters: [],
    order_by: null,
    row_limit: 1000,
    series_limit: 10,
  };
}

function withGrain(query: ChartQuery, dataset: Dataset, grain: Grain | null): ChartQuery {
  const column = query.time?.column ?? dataset.main_time_column ?? temporalColumns(dataset)[0]?.name ?? null;
  return { ...query, time: { column, grain, range: query.time?.range ?? { kind: "none" } } };
}

/** Make a query fit a chart type, keeping as much of the user's choices as possible. */
export function adaptToViz(state: ChartState, viz: VizType, dataset: Dataset): ChartState {
  let query: ChartQuery = { ...state.query };
  const display: DisplayOptions = { ...state.display };
  const grain = query.time?.grain ?? null;
  if (query.metrics.length === 0 && viz !== "table") query.metrics = ["count"];
  if (viz !== "table") query.columns = [];
  const firstCategory = () => groupableColumns(dataset).find((c) => !c.is_temporal)?.name ?? null;
  // Leaving a pivot table: its column dimensions become plain dimensions (a table keeps them).
  if (viz !== "pivot_table") {
    const across = query.column_dimensions ?? [];
    if (across.length && viz === "table") query.dimensions = [...query.dimensions, ...across.filter((d) => !query.dimensions.includes(d))];
    delete query.column_dimensions;
    delete query.totals;
  }
  if (viz !== "histogram") delete query.bins;
  // Leaving a pivot's big row limit for a chart type that draws everything.
  if (state.vizType === "pivot_table" && viz !== "pivot_table" && viz !== "table" && query.row_limit === PIVOT_ROW_LIMIT) query.row_limit = 1000;

  switch (viz) {
    case "table":
      // A table has no series: it becomes another dimension.
      if (query.series) query.dimensions = [...query.dimensions.filter((d) => d !== query.series), query.series];
      query.series = null;
      if (display.mode === "raw" && query.columns.length === 0) display.mode = "aggregate";
      break;
    case "big_number":
      query = { ...query, metrics: query.metrics.slice(0, 1), dimensions: [], series: null };
      if (grain) display.show_trend = true;
      break;
    case "bar":
      if (query.dimensions.length > 0) {
        query = withGrain({ ...query, dimensions: query.dimensions.slice(0, 1) }, dataset, null);
        if (!query.time?.column) query.time = null;
      } else if (!grain) {
        const firstDimension = groupableColumns(dataset).find((c) => !c.is_temporal);
        if (dataset.main_time_column) query = withGrain(query, dataset, "month");
        else if (firstDimension) query.dimensions = [firstDimension.name];
      }
      break;
    case "line":
    case "area":
      if (!query.series && query.dimensions.length > 0) query.series = query.dimensions[0] ?? null;
      query = withGrain({ ...query, dimensions: [] }, dataset, grain ?? "month");
      break;
    case "combo":
      // Like bar (time or one dimension on x), without a series: the metrics are the series.
      query.series = null;
      if (query.dimensions.length > 0) {
        query = withGrain({ ...query, dimensions: query.dimensions.slice(0, 1) }, dataset, null);
        if (!query.time?.column) query.time = null;
      } else if (!grain) {
        const first = firstCategory();
        if (dataset.main_time_column) query = withGrain(query, dataset, "month");
        else if (first) query.dimensions = [first];
      }
      break;
    case "treemap": {
      const levels = [...query.dimensions, ...(query.series ? [query.series] : [])].filter((d) => !temporalColumns(dataset).some((c) => c.name === d));
      const first = firstCategory();
      query = {
        ...query,
        metrics: query.metrics.slice(0, 1),
        dimensions: levels.length ? levels.slice(0, 2) : first ? [first] : [],
        series: null,
        order_by: null,
      };
      if (query.time) query.time = { ...query.time, grain: null };
      if (state.vizType !== "treemap" && state.vizType !== "pie") query.series_limit = TREEMAP_DEFAULT_TOP;
      break;
    }
    case "funnel": {
      const step = query.dimensions[0] ?? query.series ?? firstCategory();
      query = { ...query, metrics: query.metrics.slice(0, 1), dimensions: step ? [step] : [], series: null, order_by: null };
      if (query.time) query.time = { ...query.time, grain: null };
      query.row_limit = Math.min(query.row_limit, FUNNEL_MAX_STEPS);
      break;
    }
    case "gauge":
      query = { ...query, metrics: query.metrics.slice(0, 1), dimensions: [], series: null, order_by: null };
      if (query.time) query.time = { ...query.time, grain: null };
      break;
    case "heatmap": {
      // Two dimensions; with a datetime column, weekday x hour is the classic.
      const time = temporalColumns(dataset);
      const datetime = time.find((c) => c.effective_type === "datetime");
      const dims = [...query.dimensions, ...(query.series ? [query.series] : [])].filter((d) => d);
      const first = firstCategory();
      const second = groupableColumns(dataset).find((c) => !c.is_temporal && c.name !== first)?.name ?? null;
      const pair =
        dims.length >= 2
          ? dims.slice(0, 2)
          : datetime
            ? [`${datetime.name}@day_of_week`, `${datetime.name}@hour_of_day`]
            : time[0] && first
              ? [first, `${time[0].name}@month`]
              : [first, second].filter((d): d is string => Boolean(d));
      query = { ...query, metrics: query.metrics.slice(0, 1), dimensions: pair, series: null, order_by: null };
      if (query.time) query.time = { ...query.time, grain: null };
      break;
    }
    case "scatter": {
      // x, y (and maybe size) metrics; one point per value of a dimension; color by the series.
      const point = query.dimensions[0] ?? firstCategory();
      const metrics = query.metrics.length >= 2 ? query.metrics.slice(0, 3) : [...query.metrics.slice(0, 1), ...(query.metrics[0] === "count" ? [] : ["count"])];
      query = { ...query, metrics, dimensions: point ? [point] : [], order_by: null, series_limit: null };
      if (query.time) query.time = { ...query.time, grain: null };
      if (state.vizType !== "scatter") query.row_limit = SCATTER_MAX_POINTS;
      break;
    }
    case "histogram": {
      const number = usableColumns(dataset).find((c) => c.effective_type === "number" && !c.is_dimension)?.name ?? usableColumns(dataset).find((c) => c.effective_type === "number")?.name;
      query = { ...query, metrics: ["count"], dimensions: [], series: null, order_by: null };
      if (!query.bins && number) query.bins = { column: number, count: DEFAULT_BINS };
      if (query.time) query.time = { ...query.time, grain: null };
      break;
    }
    case "world_map": {
      const looksLikeCountry = groupableColumns(dataset).find((c) => !c.is_temporal && /country|nation|land|pays/i.test(`${c.name} ${c.label ?? ""}`));
      const country = looksLikeCountry?.name ?? query.dimensions[0] ?? firstCategory();
      query = { ...query, metrics: query.metrics.slice(0, 1), dimensions: country ? [country] : [], series: null, order_by: null };
      if (query.time) query.time = { ...query.time, grain: null };
      break;
    }
    case "pivot_table": {
      const rows = [...query.dimensions, ...(query.series ? [query.series] : [])];
      const across = (query.column_dimensions ?? []).filter((d) => !rows.includes(d));
      query = {
        ...query,
        dimensions: rows.slice(0, PIVOT_MAX_ROW_DIMENSIONS),
        column_dimensions: across.slice(0, PIVOT_MAX_COLUMN_DIMENSIONS),
        series: null,
        order_by: null,
      };
      if (query.dimensions.length === 0 && query.column_dimensions!.length === 0) {
        const first = firstCategory();
        if (first) query.dimensions = [first];
      }
      if (query.time) query.time = { ...query.time, grain: null };
      if (state.vizType !== "pivot_table") {
        query.totals = true;
        query.row_limit = Math.max(query.row_limit, PIVOT_ROW_LIMIT);
      }
      break;
    }
    case "pie": {
      // One dimension (the slices) and one metric; no series, no time grain.
      const slice = query.dimensions[0] ?? query.series ?? groupableColumns(dataset).find((c) => !c.is_temporal)?.name ?? null;
      query = { ...query, metrics: query.metrics.slice(0, 1), dimensions: slice ? [slice] : [], series: null, order_by: null };
      if (query.time) query.time = { ...query.time, grain: null };
      // Six slices + "Other" stays readable.
      if (state.vizType !== "pie") query.series_limit = PIE_DEFAULT_SLICES;
      break;
    }
  }
  if (query.order_by && !outputNames(query, viz, display).includes(query.order_by.by)) query.order_by = null;
  return { vizType: viz, query, display };
}

/** The result's column names for a query (for order-by choices). */
export function outputNames(query: ChartQuery, viz: VizType, display: DisplayOptions): string[] {
  if (viz === "table" && display.mode === "raw") return [...query.columns];
  const names: string[] = [];
  if (query.time?.grain && query.time.column) names.push(query.time.column);
  names.push(...query.dimensions);
  if (query.series) names.push(query.series);
  names.push(...query.metrics.map(metricName));
  return names;
}

// ---------- requests ----------

/** What to send to /api/chart-data. A big number with a trend needs two queries: the total
 * (no grain; COUNT DISTINCT / AVG can't be summed from buckets) and the trend line. */
export function chartRequests(state: ChartState): {
  main: ChartQuery;
  trend: ChartQuery | null;
  total?: ChartQuery | null;
  /** The chart type the total is asked as (default big_number: one number). */
  totalViz?: VizType;
} {
  const { vizType, display } = state;
  const query: ChartQuery = { ...state.query, filters: completeFilters(state.query.filters) };
  if (vizType !== "pivot_table") {
    delete query.column_dimensions;
    delete query.totals;
  }
  if (vizType !== "histogram") delete query.bins;
  if (vizType === "treemap") {
    const main = { ...query, columns: [], series: null, order_by: null, time: noGrain(query) };
    // Two levels: each outer box's true value (an average isn't the sum of its parts).
    const total = query.dimensions.length === 2 ? { ...main, dimensions: query.dimensions.slice(0, 1) } : null;
    return { main, trend: null, total, totalViz: "treemap" };
  }
  if (vizType === "funnel" || vizType === "gauge") {
    return { main: { ...query, columns: [], series: null, order_by: null, time: noGrain(query) }, trend: null };
  }
  if (vizType === "pivot_table" || vizType === "heatmap" || vizType === "world_map") {
    return { main: { ...query, columns: [], series: null, order_by: null, time: noGrain(query) }, trend: null };
  }
  if (vizType === "scatter") {
    return { main: { ...query, columns: [], order_by: null, series_limit: null, time: noGrain(query) }, trend: null };
  }
  if (vizType === "histogram") {
    return { main: { ...query, columns: [], dimensions: [], series: null, order_by: null, time: noGrain(query) }, trend: null };
  }
  if (vizType === "pie") {
    const main = { ...query, columns: [], series: null, order_by: null, time: noGrain(query) };
    // A donut shows the true total in the middle: the metric over everything (one more query;
    // summing slices would be wrong for averages or distinct counts).
    const total = display.donut ? { ...main, dimensions: [], series_limit: null } : null;
    return { main, trend: null, total };
  }
  if (vizType === "table" && display.mode === "raw") {
    return { main: { ...query, metrics: [], dimensions: [], series: null, time: noGrain(query) }, trend: null };
  }
  if (vizType === "table") return { main: { ...query, columns: [] }, trend: null };
  if (vizType === "big_number") {
    const grain = query.time?.grain ?? null;
    const main = { ...query, dimensions: [], series: null, columns: [], order_by: null, time: noGrain(query) };
    const trend = display.show_trend && grain ? { ...main, time: query.time, order_by: null } : null;
    return { main, trend };
  }
  return { main: { ...query, columns: [] }, trend: null };
}

/** Filters the user is still filling in are left out (instead of failing the chart). */
export function completeFilters(filters: ChartFilter[]): ChartFilter[] {
  const blank = (v: unknown) => v === "" || v === undefined;
  return filters.filter((f) => {
    if (f.operator === "IS NULL" || f.operator === "IS NOT NULL") return true;
    if (f.operator === "IN" || f.operator === "NOT IN") return Array.isArray(f.value) && f.value.length > 0;
    if (f.operator === "BETWEEN") return Array.isArray(f.value) && f.value.length === 2 && !f.value.some(blank);
    return !Array.isArray(f.value) && f.value !== null && !blank(f.value);
  });
}

function noGrain(query: ChartQuery): ChartQuery["time"] {
  return query.time ? { ...query.time, grain: null } : null;
}

export function toParams(state: ChartState): ChartParams {
  const query = { ...state.query, filters: completeFilters(state.query.filters) };
  return { query, display: state.display };
}

export function fromParams(vizType: VizType, params: ChartParams, dataset: Dataset): ChartState {
  return { vizType, query: { ...defaultQuery(dataset), ...params.query }, display: params.display };
}

/** A dimension value as shown: the dataset's value label for it ("1" -> "Lethbridge"), else
 * the value itself (time buckets by grain, NULL as "(empty)"). */
export function dimensionLabel(value: unknown, column: string | null, dataset: Dataset | null, grain: Grain | null = null): string {
  // A date bucket or time part: "Mar 2026", "Mon", "08:00".
  const { part } = column ? splitDim(column, dataset) : { part: null };
  if (part) return partValueLabel(value, part) ?? categoryLabel(value, isGrain(part) ? part : null);
  if (value !== null && value !== undefined && column && !grain) {
    const label = dataset?.columns.find((c) => c.name === column)?.value_labels?.[String(value)];
    if (label) return label;
  }
  return categoryLabel(value, grain);
}

// ---------- switching chart type: what carried over ----------

export type SwitchReport = {
  /** What the new chart kept: "dataset", metric labels, "2 filters", the time range. */
  kept: string[];
  /** What it couldn't use, with why. */
  dropped: string[];
  /** What still needs picking before it can draw. */
  todo: string[];
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What still needs to be set for a chart to draw (empty: ready). */
export function missingFor(state: ChartState, dataset: Dataset): string[] {
  const { vizType, query } = state;
  const grain = query.time?.grain ?? null;
  const todo: string[] = [];
  if (vizType !== "table" && query.metrics.length === 0) todo.push("Pick a metric");
  switch (vizType) {
    case "bar":
    case "combo":
      if (!grain && query.dimensions.length === 0) todo.push("Pick the x axis (a dimension or time)");
      if (vizType === "combo" && query.metrics.length < 2) todo.push("Add a second metric to show bars and lines together");
      break;
    case "line":
    case "area":
      if (temporalColumns(dataset).length === 0) todo.push("This dataset has no time column: mark one as temporal");
      break;
    case "pie":
      if (query.dimensions.length === 0) todo.push("Pick the slices (a dimension)");
      break;
    case "treemap":
      if (query.dimensions.length === 0) todo.push("Pick the boxes (a dimension)");
      break;
    case "funnel":
      if (query.dimensions.length === 0) todo.push("Pick the steps (a dimension)");
      break;
    case "pivot_table":
      if (query.dimensions.length === 0 && (query.column_dimensions ?? []).length === 0) todo.push("Add a row or column dimension");
      break;
    case "heatmap":
      if (query.dimensions.length < 2) todo.push("Pick the heatmap's rows and columns (two dimensions)");
      break;
    case "scatter":
      if (query.metrics.length < 2) todo.push("Pick a metric for the y axis");
      if (query.dimensions.length === 0) todo.push("Pick what each point is (a dimension)");
      break;
    case "histogram":
      if (!query.bins?.column) todo.push("Pick a number column to bin");
      break;
    case "world_map":
      if (query.dimensions.length === 0) todo.push("Pick the column with the countries");
      break;
  }
  return todo;
}

/** Compare a chart before and after a type switch (shown under the chart type picker). */
export function switchReport(before: ChartState, after: ChartState, dataset: Dataset): SwitchReport {
  const kept = ["dataset"];
  const dropped: string[] = [];
  const name = vizLabel(after.vizType).toLowerCase();
  const b = before.query;
  const a = after.query;

  const afterMetrics = new Set(a.metrics.map(metricName));
  const keptMetrics = b.metrics.filter((m) => afterMetrics.has(metricName(m)));
  if (keptMetrics.length) kept.push(...keptMetrics.map((m) => metricLabel(m, dataset)));
  const lostMetrics = b.metrics.filter((m) => !afterMetrics.has(metricName(m)));
  if (lostMetrics.length && a.metrics.length) {
    dropped.push(`${lostMetrics.map((m) => metricLabel(m, dataset)).join(", ")} (a ${name} uses one metric)`);
  }

  const groupsAfter = new Set([...a.dimensions, ...(a.column_dimensions ?? []), ...(a.series ? [a.series] : [])]);
  const groupsBefore = [...b.dimensions, ...(b.column_dimensions ?? []), ...(b.series ? [b.series] : [])];
  const lostGroups = groupsBefore.filter((g) => !groupsAfter.has(g));
  if (lostGroups.length) dropped.push(`${lostGroups.map((g) => columnLabel(g, dataset)).join(", ")} (not used by a ${name})`);
  if (b.columns.length && !a.columns.length) dropped.push(`${plural(b.columns.length, "raw column")} (only tables list raw records)`);
  if (b.bins && !a.bins) dropped.push(`the bins of ${columnLabel(b.bins.column, dataset)} (only histograms bin)`);

  const filters = completeFilters(b.filters).length;
  if (filters) kept.push(plural(filters, "filter"));
  const range = b.time?.range.kind ?? "none";
  if (range !== "none") {
    if ((a.time?.range.kind ?? "none") === range) kept.push(range === "custom" ? "custom time range" : range.replace(/_/g, " "));
    else dropped.push("time range");
  }
  const grainBefore = b.time?.grain ?? null;
  const grainAfter = a.time?.grain ?? null;
  if (grainBefore && !grainAfter) dropped.push(`time grain (a ${name} has none; the time range still filters)`);
  return { kept, dropped, todo: missingFor(after, dataset) };
}
