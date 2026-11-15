/** Names the wizard suggests (pure). */
import type { Dataset } from "../api.ts";
import { columnLabel, metricLabel, type ChartState } from "../charts/model.ts";

/** `wanted`, or "wanted 2", "wanted 3"… when taken (case-insensitive). */
export function freeName(wanted: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  let name = wanted;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${wanted} ${n}`;
  return name;
}

/** "Total revenue", "Revenue by category", "Revenue by month" (like the prototype's titles). */
export function suggestChartName(state: ChartState, dataset: Dataset): string {
  const metric = state.query.metrics[0];
  const what = metric ? metricLabel(metric, dataset) : "Rows";
  if (state.vizType === "big_number") return `Total ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
  const dimension = state.query.dimensions[0];
  if (dimension) return `${what} by ${columnLabel(dimension, dataset).toLowerCase()}`;
  const grain = state.query.time?.grain;
  if (grain && grain !== "raw") return `${what} by ${grain}`;
  return what;
}
