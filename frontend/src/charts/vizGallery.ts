/** The chart type gallery: groups, one-line descriptions and search (lazy: chart editor only). */
import type { VizType } from "../api.ts";
import { VIZ_LABELS } from "./vizTypes.ts";

export type VizGroup = "Trends" | "Compare" | "Part of whole" | "Single value" | "Tables" | "Distribution" | "Geo";
export const VIZ_GROUPS: VizGroup[] = ["Trends", "Compare", "Part of whole", "Single value", "Tables", "Distribution", "Geo"];

export type VizInfo = {
  value: VizType;
  label: string;
  group: VizGroup;
  /** One line in the gallery. */
  description: string;
  /** Extra words the gallery search matches. */
  keywords: string[];
};

const info = (value: VizType, group: VizGroup, description: string, keywords: string[]): VizInfo => ({
  value,
  label: VIZ_LABELS[value],
  group,
  description,
  keywords,
});

/** Every chart type, in gallery order. */
export const VIZ_INFO: VizInfo[] = [
  info("line", "Trends", "A metric over time", ["time", "trend", "series"]),
  info("area", "Trends", "Over time, stacked or as shares", ["time", "stacked", "100%", "percent", "share"]),
  info("bar", "Compare", "Categories or periods side by side", ["column", "horizontal", "stacked"]),
  info("combo", "Compare", "Bars and lines, two axes", ["mixed", "dual axis", "bar line", "two metrics"]),
  info("pie", "Part of whole", "Shares of one total", ["donut", "doughnut", "ring", "share", "percent"]),
  info("treemap", "Part of whole", "Nested boxes sized by value", ["hierarchy", "boxes", "nested", "share"]),
  info("funnel", "Part of whole", "Steps and drop-off", ["conversion", "steps", "pipeline", "drop-off"]),
  info("big_number", "Single value", "One number, with trend", ["kpi", "metric", "total", "number", "single"]),
  info("gauge", "Single value", "One number against a range", ["kpi", "dial", "meter", "target", "progress"]),
  info("table", "Tables", "Grouped rows or raw records", ["list", "grid", "records", "rows"]),
  info("pivot_table", "Tables", "Rows × columns with totals", ["crosstab", "cross tab", "matrix", "totals", "subtotals", "heat"]),
  info("histogram", "Distribution", "How values spread, in bins", ["bins", "spread", "frequency", "buckets"]),
  info("scatter", "Distribution", "Two metrics, one point each", ["bubble", "correlation", "points", "x y", "dots"]),
  info("heatmap", "Distribution", "Two dimensions, colored by value", ["grid", "matrix", "weekday", "hour", "calendar", "heat"]),
  info("world_map", "Geo", "Countries colored by value", ["map", "geo", "country", "countries", "choropleth", "world"]),
];

/** Gallery search: label, group, description and keywords, case-insensitive. */
export function searchViz(text: string): VizInfo[] {
  const q = text.trim().toLowerCase();
  if (!q) return VIZ_INFO;
  return VIZ_INFO.filter((v) => [v.label, v.group, v.description, ...v.keywords].some((w) => w.toLowerCase().includes(q)));
}
