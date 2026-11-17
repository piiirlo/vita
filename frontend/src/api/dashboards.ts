/** Dashboards, their filters, and a column's values for a values filter: /api/dashboards (types mirror backend/app/schemas). */

import type { FilterScalar, RangeKind, VizType } from "./charts.ts";
import { inProject, json, request, withProject } from "./http.ts";


// ---------- dashboard filters ----------

export type DashboardFilterKind = "time" | "values" | "range";
export type ChartTimeRange = { kind: RangeKind; start?: string | null; end?: string | null };

/** The current value of a dashboard filter (its saved default, or what the URL says). Only the
 * field of the filter's kind is read; an empty selection filters nothing. */
export type FilterSelection = {
  time_range?: ChartTimeRange | null;
  values?: FilterScalar[] | null;
  min?: number | null;
  max?: number | null;
};

/** A filter in a dashboard's filter bar. It targets every chart whose dataset has `column`
 * (time: every chart with a time column), or exactly the charts in `targets`. */
export type DashboardFilterDef = {
  id: string;
  kind: DashboardFilterKind;
  label: string;
  column: string | null;
  /** Values filters: the dataset their choices come from. */
  dataset_id: number | null;
  targets: number[] | null;
  default: FilterSelection;
  /** Values filters: other filters (ids) whose current values limit the choices. */
  depends_on?: string[];
};

/** A dashboard filter sent with a chart-data request (only those that target the chart). */
export type AppliedDashboardFilter = FilterSelection & { id: string; kind: DashboardFilterKind; column: string | null };

export type ColumnValues = { column: string; values: FilterScalar[]; truncated: boolean; cached_at: string | null };

/** The distinct values of a column (at most 1000, sorted; `q`: contains, text columns only). */
export function getColumnValues(
  datasetId: number,
  column: string,
  q?: string,
  signal?: AbortSignal,
  filters: AppliedDashboardFilter[] = [],
) {
  const params = new URLSearchParams({ column });
  if (q?.trim()) params.set("q", q.trim());
  // The filters it depends on (City: only the cities of the chosen Country).
  if (filters.length) params.set("filters", JSON.stringify(filters));
  return request<ColumnValues>(`/api/datasets/${datasetId}/values?${params}`, { signal });
}

// ---------- dashboards ----------

export type RefreshInterval = "off" | "1m" | "5m" | "15m" | "1h";

type TilePosition = { id: string; x: number; y: number; w: number; h: number };
export type ChartTileSpec = TilePosition & { type: "chart"; chart_id: number };
export type TextTileSpec = TilePosition & { type: "text"; text: string };
export type DashboardTile = ChartTileSpec | TextTileSpec;

export type DashboardChartInfo = { id: number; name: string; viz_type: VizType };

export type DashboardListItem = {
  id: number;
  /** The project it belongs to (null: the built-in Uploads connection). */
  project_id?: number | null;
  name: string;
  description: string | null;
  chart_count: number;
  created_at: string;
  updated_at: string;
};

export type Dashboard = Omit<DashboardListItem, "chart_count"> & {
  layout: DashboardTile[];
  refresh_interval: RefreshInterval;
  /** Cache lifetime for every tile (seconds, 0 = off); null = each chart's own. */
  cache_ttl: number | null;
  /** Basic info of the charts in the layout, keyed by chart id. */
  charts: Record<string, DashboardChartInfo>;
  /** The filter bar, with each filter's default value. */
  filters: DashboardFilterDef[];
  /** Clicking a chart element filters the other charts. */
  cross_filtering: boolean;
};

export type DashboardInput = {
  name: string;
  description: string | null;
  layout: DashboardTile[];
  refresh_interval: RefreshInterval;
  cache_ttl?: number | null;
  /** Left out: the saved filters are kept. */
  filters?: DashboardFilterDef[];
  cross_filtering?: boolean;
};

export function listDashboards(q?: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const query = params.toString();
  return request<DashboardListItem[]>(withProject(`/api/dashboards${query ? `?${query}` : ""}`));
}

export const getDashboard = (id: number) => request<Dashboard>(`/api/dashboards/${id}`);

export const createDashboard = (input: DashboardInput) =>
  request<Dashboard>("/api/dashboards", { method: "POST", body: json(inProject(input)) });

export const updateDashboard = (id: number, input: DashboardInput) =>
  request<Dashboard>(`/api/dashboards/${id}`, { method: "PUT", body: json(input) });

export const deleteDashboard = (id: number) =>
  request<void>(`/api/dashboards/${id}`, { method: "DELETE" });

export const duplicateDashboard = (id: number) =>
  request<Dashboard>(`/api/dashboards/${id}/duplicate`, { method: "POST" });

/** Adds a chart tile below the existing tiles. */
export const addChartToDashboard = (id: number, chartId: number) =>
  request<Dashboard>(`/api/dashboards/${id}/charts`, { method: "POST", body: json({ chart_id: chartId }) });
