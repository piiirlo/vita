/** Loading one chart tile: saved chart -> its dataset (cached per dashboard) -> chart data. */
import { createContext } from "react";
import { fetchChartData, getChart, getDataset, type ChartDataResult, type Dataset, type SavedChart } from "../api.ts";
import { chartRequests, fromParams, type ChartState } from "../charts/model.ts";
import { RequestQueue } from "./queue.ts";

export const MAX_PARALLEL_TILES = 4;

export type TileData = {
  chart: SavedChart;
  dataset: Dataset;
  state: ChartState;
  main: ChartDataResult;
  trend: ChartDataResult | null;
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

export async function loadTileData(chartId: number, datasets: DatasetCache, signal: AbortSignal): Promise<TileData> {
  const chart = await getChart(chartId);
  const dataset = await datasets.get(chart.dataset_id);
  const state = fromParams(chart.viz_type, chart.params, dataset);
  const requests = chartRequests(state);
  const [main, trend] = await Promise.all([
    fetchChartData(state.vizType, requests.main, signal),
    requests.trend ? fetchChartData("line", requests.trend, signal) : Promise.resolve(null),
  ]);
  return { chart, dataset, state, main, trend, loadedAt: Date.now() };
}

export type DashboardContextValue = {
  queue: RequestQueue;
  datasets: DatasetCache;
  dashboardId: number;
  /** Changes on "Refresh all" and auto-refresh. */
  refreshKey: number;
};

export const DashboardContext = createContext<DashboardContextValue | null>(null);
