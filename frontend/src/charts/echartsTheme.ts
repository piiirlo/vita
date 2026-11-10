/** ECharts themes ("vita-light" / "vita-dark") built from the design tokens at runtime, so
 * the CSS variables stay the single source of colors. Charts animate in (lines draw, bars
 * grow) unless the user prefers reduced motion. */
import * as echarts from "echarts/core";
import { cssVar } from "../lib/cssVar.ts";
import type { ResolvedTheme } from "../theme/theme.ts";

export const SERIES_COUNT = 8;

export function seriesColors(): string[] {
  return Array.from({ length: SERIES_COUNT }, (_, i) => cssVar(`--series-${i + 1}`));
}

function buildTheme(reducedMotion: boolean): Record<string, unknown> {
  const v = cssVar;
  const mono = v("--font-mono") || "monospace";
  const ui = v("--font-ui") || "sans-serif";
  const axisLabel = { color: v("--text-muted"), fontFamily: mono, fontSize: 11 };
  const axisName = { color: v("--text-muted"), fontFamily: mono, fontSize: 11 };

  return {
    color: seriesColors(),
    backgroundColor: "transparent",
    textStyle: { fontFamily: ui, color: v("--text") },

    animation: !reducedMotion,
    animationDuration: 850,
    animationEasing: "cubicOut",
    animationDurationUpdate: 350,
    animationEasingUpdate: "cubicOut",

    categoryAxis: {
      axisLine: { show: true, lineStyle: { color: v("--border-strong") } },
      axisTick: { show: false },
      axisLabel,
      nameTextStyle: axisName,
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel,
      nameTextStyle: axisName,
      splitLine: { show: true, lineStyle: { color: v("--chart-grid") } },
    },
    legend: {
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      textStyle: { color: v("--text"), fontFamily: ui, fontSize: 13 },
      pageTextStyle: { color: v("--text-muted"), fontFamily: mono },
      pageIconColor: v("--text"),
      pageIconInactiveColor: v("--text-faint"),
    },
    // Tooltip styled like a card.
    tooltip: {
      backgroundColor: v("--surface-raised"),
      borderColor: v("--border-strong"),
      borderWidth: 1,
      padding: [10, 12],
      textStyle: { color: v("--text"), fontFamily: ui, fontSize: 13 },
      extraCssText: `border-radius: 14px; box-shadow: 0 18px 50px -20px ${v("--shadow")};`,
      axisPointer: {
        lineStyle: { color: v("--border-hover"), type: "dashed" },
        shadowStyle: { color: v("--hover") },
        crossStyle: { color: v("--border-hover") },
      },
    },
    line: {
      symbol: "circle",
      symbolSize: 6,
      lineStyle: { width: 2.4, cap: "round", join: "round" },
    },
    bar: { itemStyle: { borderRadius: 4 } },
  };
}

/** Register (or refresh) the theme for the current mode and return its name. */
export function registerVitaTheme(mode: ResolvedTheme, reducedMotion: boolean): string {
  const name = `vita-${mode}`;
  echarts.registerTheme(name, buildTheme(reducedMotion));
  return name;
}
