/** ECharts themes ("vita-light" / "vita-dark") built from the design tokens at runtime, so
 * the CSS variables stay the single source of colors (the Ignara look: hairline grid, muted
 * axis labels, an inverted tooltip). Charts animate in (lines draw, bars grow; expo-like
 * easing) unless the user prefers reduced motion. */
import * as echarts from "echarts/core";
import { paperVar as cssVar } from "../lib/cssVar.ts";
import type { ResolvedTheme } from "../theme/theme.ts";

export const SERIES_COUNT = 10;

export function seriesColors(): string[] {
  return Array.from({ length: SERIES_COUNT }, (_, i) => cssVar(`--series-${i + 1}`));
}

function buildTheme(reducedMotion: boolean): Record<string, unknown> {
  const v = cssVar;
  const mono = v("--font-mono") || "monospace";
  const ui = v("--font-ui") || "sans-serif";
  const axisLabel = { color: v("--text-muted"), fontFamily: mono, fontSize: 11, fontWeight: 600 };
  const axisName = { color: v("--text-muted"), fontFamily: mono, fontSize: 11, fontWeight: 600 };

  return {
    color: seriesColors(),
    backgroundColor: "transparent",
    textStyle: { fontFamily: ui, color: v("--text"), fontWeight: 500 },

    animation: !reducedMotion,
    // Ignara: things grow in with expo.out (~1.1s) and morph with expo.inOut (0.9s). Per
    // series timings are set by ignaraStyle.ts.
    animationDuration: 1100,
    animationEasing: "exponentialOut",
    animationDurationUpdate: 900,
    animationEasingUpdate: "exponentialInOut",

    categoryAxis: {
      // The baseline: one solid hairline; no ticks.
      axisLine: { show: true, lineStyle: { color: v("--border-strong"), width: 1 } },
      axisTick: { show: false },
      axisLabel: { ...axisLabel, margin: 10 },
      nameTextStyle: axisName,
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel,
      nameTextStyle: axisName,
      // Grid lines dashed (Ignara's 1px dashed --line-2).
      splitLine: { show: true, lineStyle: { color: v("--border-strong"), type: [4, 4], width: 1 } },
    },
    legend: {
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      itemStyle: { borderRadius: 3 },
      textStyle: { color: v("--text-muted"), fontFamily: ui, fontSize: 12.5, fontWeight: 600 },
      pageTextStyle: { color: v("--text-muted"), fontFamily: mono },
      pageIconColor: v("--text"),
      pageIconInactiveColor: v("--text-faint"),
    },
    // Tooltip: inverted, like Ignara's chart tips.
    tooltip: {
      backgroundColor: v("--inverse-bg"),
      borderColor: v("--inverse-bg"),
      borderWidth: 0,
      padding: [7, 10],
      textStyle: { color: v("--inverse-fg"), fontFamily: ui, fontSize: 12.5, fontWeight: 600 },
      extraCssText: `border-radius: 10px; box-shadow: ${v("--shadow")};`,
      // The hover cursor: a solid 1px line (Ignara's chart cursor).
      axisPointer: {
        lineStyle: { color: v("--border-strong"), type: "solid", width: 1 },
        shadowStyle: { color: v("--hover") },
        crossStyle: { color: v("--border-hover") },
      },
    },
    line: {
      symbol: "circle",
      symbolSize: 6,
      lineStyle: { width: 2.4, cap: "round", join: "round" },
    },
    bar: { itemStyle: { borderRadius: [8, 8, 3, 3] } },
  };
}

/** Register (or refresh) the theme for the current mode and return its name. */
export function registerVitaTheme(mode: ResolvedTheme, reducedMotion: boolean): string {
  const name = `vita-${mode}`;
  echarts.registerTheme(name, buildTheme(reducedMotion));
  return name;
}
