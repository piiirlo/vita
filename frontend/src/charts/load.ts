/** Loading everything a chart needs to draw (chart editor and dashboard tiles alike). */
import { fetchChartData, type CacheOptions, type ChartDataResult, type ChartQuery } from "../api.ts";
import { localToday, previousRange } from "./display.ts";
import { chartRequests, type ChartState } from "./model.ts";

export type ChartData = {
  main: ChartDataResult;
  /** Big number trend line. */
  trend: ChartDataResult | null;
  /** Big number "vs previous period": the same metric over the period before the range. */
  previous: ChartDataResult | null;
  /** Donut: the metric over everything (its center label). */
  total?: ChartDataResult | null;
};

/** The big number query for the period before the one `main` covered (null: no comparison). */
export function previousQuery(state: ChartState, mainQuery: ChartQuery, main: ChartDataResult, today: string): ChartQuery | null {
  if (state.vizType !== "big_number" || !state.display.compare_previous || !mainQuery.time) return null;
  const range = previousRange(mainQuery.time.range.kind, main.range_start, main.range_end, today);
  if (!range) return null;
  return { ...mainQuery, time: { ...mainQuery.time, grain: null, range: { kind: "custom", start: range.start, end: range.end } } };
}

/** What makes a chart need new data: the queries (and whether to compare). Display-only
 * options are not in it, so changing them never queries the database. */
export function dataKey(state: ChartState): string {
  const { main, trend, total } = chartRequests(state);
  const compare = state.vizType === "big_number" && Boolean(state.display.compare_previous);
  return JSON.stringify({ v: state.vizType, main, trend, total, compare });
}

/** Main result, trend and comparison. `cache`: the chart-data cache lifetime (default: the
 * chart's own `cache_ttl`, else 10 minutes) and whether to skip it ("Refresh"). */
export async function loadChartData(
  state: ChartState,
  signal: AbortSignal,
  cache: CacheOptions = {},
  today = localToday(),
): Promise<ChartData> {
  const options: CacheOptions = { cacheTtl: cache.cacheTtl ?? state.display.cache_ttl ?? null, refresh: cache.refresh };
  const requests = chartRequests(state);
  const [main, trend, total] = await Promise.all([
    fetchChartData(state.vizType, requests.main, signal, options),
    requests.trend ? fetchChartData("line", requests.trend, signal, options) : Promise.resolve(null),
    // A failing donut total only loses the center label.
    requests.total ? fetchChartData("big_number", requests.total, signal, options).catch(() => null) : Promise.resolve(null),
  ]);
  const query = previousQuery(state, requests.main, main, today);
  // A failing comparison only loses the comparison, never the chart.
  const previous = query ? await fetchChartData("big_number", query, signal, options).catch(() => null) : null;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return { main, trend, previous, total };
}

/** Cache lifetimes offered in the UI (seconds; 0 = don't cache). */
export const CACHE_TTLS: { value: number; label: string }[] = [
  { value: 0, label: "Off (always query)" },
  { value: 60, label: "1 minute" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
  { value: 1800, label: "30 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 21_600, label: "6 hours" },
  { value: 86_400, label: "1 day" },
];
export const DEFAULT_CACHE_TTL = 600;
