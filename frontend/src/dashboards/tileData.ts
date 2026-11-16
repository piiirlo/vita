/** Loading one chart tile: saved chart -> its dataset (cached per dashboard) -> chart data. */
import { createContext } from "react";
import { getChart, getDataset, type CacheOptions, type ChartDataResult, type Dataset, type DashboardFilterDef, type SavedChart } from "../api.ts";
import { loadChartData } from "../charts/load.ts";
import { fromParams, type ChartState } from "../charts/model.ts";
import type { CrossSelection } from "../charts/crossSelect.ts";
import { crossFiltersFor, filtersForChart, tileFilterStatus, type CrossFilter, type FilterValues } from "./filters.ts";
import { RequestQueue } from "./queue.ts";

export const MAX_PARALLEL_TILES = 4;

export type TileData = {
  chart: SavedChart;
  dataset: Dataset;
  state: ChartState;
  main: ChartDataResult;
  trend: ChartDataResult | null;
  previous: ChartDataResult | null;
  total: ChartDataResult | null;
  loadedAt: number;
  /** The dashboard filters that were active when it loaded: those that changed its data and
   * those that didn't apply to it. */
  filteredBy: DashboardFilterDef[];
  notFilteredBy: DashboardFilterDef[];
};

/** A dashboard's filters and their current values. */
export type DashboardFilters = { defs: DashboardFilterDef[]; values: FilterValues; cross?: CrossFilter[] };

/** Datasets shared by the tiles of one dashboard (several charts often use the same one). */
export class DatasetCache {
  private cache = new Map<number, Promise<Dataset>>();

  get(id: number): Promise<Dataset> {
    let entry = this.cache.get(id);
    if (!entry) {
      entry = getDataset(id);
      entry.catch(() => this.cache.delete(id)); // don't keep failures
      this.cache.set(id, entry);
    }
    return entry;
  }

  clear(): void {
    this.cache.clear();
  }
}

/** `cache`: the dashboard's cache lifetime (null: the chart's own) and whether to skip it. */
export async function loadTileData(
  chartId: number,
  datasets: DatasetCache,
  signal: AbortSignal,
  cache: CacheOptions = {},
  filters: DashboardFilters = { defs: [], values: {} },
  tileId: string | null = null,
): Promise<TileData> {
  const chart = await getChart(chartId);
  const dataset = await datasets.get(chart.dataset_id);
  const state = fromParams(chart.viz_type, chart.params, dataset);
  // The filter bar's filters, then the other tiles' cross filters (never the tile's own).
  const cross = crossFiltersFor(filters.cross ?? [], tileId);
  const defs = [...filters.defs, ...cross.defs];
  const values = { ...filters.values, ...cross.values };
  const applied = filtersForChart(defs, values, chart.id, dataset);
  const { main, trend, previous, total } = await loadChartData(state, signal, cache, undefined, applied);
  const status = tileFilterStatus(defs, values, main.dashboard_filters_applied);
  return { chart, dataset, state, main, trend, previous, total: total ?? null, loadedAt: Date.now(), ...status };
}

export type DashboardContextValue = {
  queue: RequestQueue;
  datasets: DatasetCache;
  dashboardId: number;
  /** Changes on "Refresh all" and auto-refresh. */
  refreshKey: number;
  /** The dashboard's cache lifetime for every tile (seconds; 0 = off); null = each chart's own. */
  cacheTtl: number | null;
  /** The filter bar's filters and their values (debounced); `filtersKey` changes with them. */
  filters: DashboardFilters;
  filtersKey: string;
  /** Cross-filtering is on (and not editing): clicks on chart elements call this. */
  onCrossSelect?: (tile: string, selection: CrossSelection) => void;
  /** Removes a tile's own cross filter (its "Filtering" badge). */
  onCrossClear?: (tile: string) => void;
};

export const DashboardContext = createContext<DashboardContextValue | null>(null);
