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

export type ChartState = { vizType: VizType; query: ChartQuery; display: DisplayOptions };

/** Top slices of a new pie (the rest is grouped into "Other"). */
export const PIE_DEFAULT_SLICES = 6;
/** More slices than this are hard to read. */
export const PIE_MAX_READABLE = 7;

export const VIZ_TYPES: { value: VizType; label: string }[] = [
  { value: "table", label: "Table" },
  { value: "big_number", label: "Big number" },
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "pie", label: "Pie" },
];

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

export function columnLabel(name: string, dataset: Dataset | null): string {
  const col = dataset?.columns.find((c) => c.name === name);
  return col?.label || name;
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
      if (!query.series && query.dimensions.length > 0) query.series = query.dimensions[0] ?? null;
      query = withGrain({ ...query, dimensions: [] }, dataset, grain ?? "month");
      break;
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
export function chartRequests(state: ChartState): { main: ChartQuery; trend: ChartQuery | null; total?: ChartQuery | null } {
  const { vizType, display } = state;
  const query = { ...state.query, filters: completeFilters(state.query.filters) };
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
  if (value !== null && value !== undefined && column && !grain) {
    const label = dataset?.columns.find((c) => c.name === column)?.value_labels?.[String(value)];
    if (label) return label;
  }
  return categoryLabel(value, grain);
}
