/** Chart type names only (the charts list and "Add chart" use them, so this file stays tiny:
 * it's in the main bundle). The gallery's groups, descriptions and search are in
 * vizGallery.ts, which only the lazy chart editor loads. */
import type { VizType } from "../api.ts";

export const VIZ_LABELS: Record<VizType, string> = {
  line: "Line",
  area: "Area",
  bar: "Bar",
  combo: "Combo",
  pie: "Pie / donut",
  treemap: "Treemap",
  funnel: "Funnel",
  big_number: "Big number",
  gauge: "Gauge",
  table: "Table",
  pivot_table: "Pivot table",
  heatmap: "Heatmap",
  scatter: "Scatter / bubble",
  histogram: "Histogram",
  world_map: "World map",
};

export const vizLabel = (viz: string) => VIZ_LABELS[viz as VizType] ?? viz;
