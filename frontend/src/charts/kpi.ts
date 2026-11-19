import type { DisplayOptions } from "./model.ts";

/** Which big number layout: Ignara's KPI card by default, the ember hero card, or the classic
 * centered number. */
export function kpiStyle(display: DisplayOptions): "card" | "hero" | "classic" {
  return display.kpi_style ?? "card";
}

/** Bars drawn as Ignara's lollipops: one series of vertical, unstacked bars, unless the chart
 * asks for classic bars. */
export function lollipopBars(display: DisplayOptions, seriesCount: number): boolean {
  return (display.bar_style ?? "lollipop") === "lollipop" && seriesCount === 1 && !display.horizontal && !display.stacked;
}
