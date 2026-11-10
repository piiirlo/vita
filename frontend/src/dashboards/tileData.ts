/** Loading one chart tile: saved chart -> its dataset (cached per dashboard) -> chart data. */
import { createContext } from "react";
import { getChart, getDataset, type CacheOptions, type ChartDataResult, type Dataset, type SavedChart } from "../api.ts";
import { loadChartData } from "../charts/load.ts";
import { fromParams, type ChartState } from "../charts/model.ts";
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
};

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
): Promise<TileData> {
  const chart = await getChart(chartId);
  const dataset = await datasets.get(chart.dataset_id);
  const state = fromParams(chart.viz_type, chart.params, dataset);
  const { main, trend, previous, total } = await loadChartData(state, signal, cache);
  return { chart, dataset, state, main, trend, previous, total: total ?? null, loadedAt: Date.now() };
}

export type DashboardContextValue = {
  queue: RequestQueue;
  datasets: DatasetCache;
  dashboardId: number;
  /** Changes on "Refresh all" and auto-refresh. */
  refreshKey: number;
  /** The dashboard's cache lifetime for every tile (seconds; 0 = off); null = each chart's own. */
  cacheTtl: number | null;
};

export const DashboardContext = createContext<DashboardContextValue | null>(null);
