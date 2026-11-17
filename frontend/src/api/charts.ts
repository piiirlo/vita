/** Charts and chart data: /api/charts, /api/chart-data (types mirror backend/app/schemas). */

import type { AppliedDashboardFilter } from "./dashboards.ts";
import { inProject, json, request, withProject } from "./http.ts";
import type { QueryResult } from "./queries.ts";


// ---------- charts ----------

export type VizType =
  | "table"
  | "big_number"
  | "bar"
  | "line"
  | "pie"
  | "area"
  | "combo"
  | "treemap"
  | "funnel"
  | "gauge"
  | "pivot_table"
  | "heatmap"
  | "scatter"
  | "histogram"
  | "world_map";
export type Aggregate = "SUM" | "AVG" | "MIN" | "MAX" | "COUNT" | "COUNT_DISTINCT";
export type Grain = "day" | "week" | "month" | "quarter" | "year";
/** A chart's time axis: a grain's buckets, or "raw" = every time value as it is. */
export type AxisGrain = Grain | "raw";
export type RangeKind =
  | "none"
  | "last_7_days"
  | "last_30_days"
  | "last_90_days"
  | "last_12_months"
  | "this_year"
  | "last_year"
  | "custom";
export type FilterOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "IN"
  | "NOT IN"
  | "BETWEEN"
  | "IS NULL"
  | "IS NOT NULL"
  | "LIKE";

export type AdhocMetric = { column: string; aggregate: Aggregate; label?: string | null };
/** Custom SQL written in the chart editor, e.g. SUM(amount) / NULLIF(SUM(quantity), 0): the
 * same checks as a saved metric's expression. Its label is its output name. */
export type SqlMetric = { sql: string; label: string; number_format?: string | null };
/** A saved metric of the dataset (by name), an ad-hoc one, or custom SQL. */
export type MetricRef = string | AdhocMetric | SqlMetric;

export const isSqlMetric = (ref: MetricRef): ref is SqlMetric => typeof ref !== "string" && "sql" in ref;
export const isAdhocMetric = (ref: MetricRef): ref is AdhocMetric => typeof ref !== "string" && "column" in ref;
export type FilterScalar = string | number | boolean | null;

export type ChartFilter = {
  column: string;
  operator: FilterOperator;
  value: FilterScalar | FilterScalar[];
};

export type ChartQuery = {
  dataset_id: number;
  metrics: MetricRef[];
  /** Grouping dimensions (treemap: its levels, outer first; pivot table: the rows). */
  dimensions: string[];
  /** Pivot table: the dimensions across. */
  column_dimensions?: string[];
  /** Pivot table: subtotals and totals, computed in SQL (rows carry __row_level / __col_level). */
  totals?: boolean;
  series: string | null;
  /** Histogram: the number column, cut into `count` bins between its min and max, or bins of
   * `width` (aligned to multiples of it). Rows come back as __bin / __bin_start / __bin_end. */
  bins?: { column: string; count?: number | null; width?: number | null } | null;
  /** Table "raw records" mode. */
  columns: string[];
  time: {
    column: string | null;
    grain: AxisGrain | null;
    range: { kind: RangeKind; start?: string | null; end?: string | null };
  } | null;
  filters: ChartFilter[];
  order_by: { by: string; descending: boolean } | null;
  row_limit: number;
  series_limit: number | null;
};

/** range_start / range_end: the time range the query filtered on (days, both inclusive; null = open
 * on that side or no range). */
export type ChartDataResult = QueryResult & {
  sql: string;
  range_start?: string | null;
  range_end?: string | null;
  /** Set when the result came from the chart-data cache: when it was computed. */
  cached_at?: string | null;
  /** Ids of the dashboard filters that changed this query (the others didn't apply). */
  dashboard_filters_applied?: string[];
};

/** Chart-data cache options: lifetime in seconds (0 = off, null = default 10 min), refresh = skip it. */
export type CacheOptions = { cacheTtl?: number | null; refresh?: boolean };

/** Where a dataset has data: MIN / MAX of a time column (ISO strings; null when it has none). */
export type TimeExtent = { column: string; min: string | null; max: string | null };

export type ChartParams = { query: ChartQuery; display: Record<string, unknown> };

export type SavedChart = {
  id: number;
  /** The project it belongs to (null: the built-in Uploads connection). */
  project_id?: number | null;
  name: string;
  description: string | null;
  dataset_id: number;
  dataset_name: string;
  viz_type: VizType;
  params: ChartParams;
  created_at: string;
  updated_at: string;
  /** The dashboards showing this chart (one chart's responses; empty in lists). */
  dashboards?: { id: number; name: string }[];
};

export type ChartInput = {
  name: string;
  description: string | null;
  viz_type: VizType;
  params: ChartParams;
};

/** Throws ApiError; invalid queries and failed queries have a QueryErrorDetail `detail`. */
export const fetchChartData = (
  vizType: VizType,
  query: ChartQuery,
  signal?: AbortSignal,
  cache: CacheOptions = {},
  dashboardFilters: AppliedDashboardFilter[] = [],
) =>
  request<ChartDataResult>("/api/chart-data", {
    method: "POST",
    body: json({
      viz_type: vizType,
      query,
      ...(dashboardFilters.length ? { dashboard_filters: dashboardFilters } : {}),
      ...(cache.cacheTtl === undefined || cache.cacheTtl === null ? {} : { cache_ttl: cache.cacheTtl }),
      ...(cache.refresh ? { refresh: true } : {}),
    }),
    signal,
  });

export function listCharts(q?: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const query = params.toString();
  return request<SavedChart[]>(withProject(`/api/charts${query ? `?${query}` : ""}`));
}

export const getChart = (id: number) => request<SavedChart>(`/api/charts/${id}`);

export const createChart = (input: ChartInput) =>
  request<SavedChart>("/api/charts", { method: "POST", body: json(inProject(input)) });

export const updateChart = (id: number, input: ChartInput) =>
  request<SavedChart>(`/api/charts/${id}`, { method: "PUT", body: json(input) });

export const deleteChart = (id: number) => request<void>(`/api/charts/${id}`, { method: "DELETE" });
