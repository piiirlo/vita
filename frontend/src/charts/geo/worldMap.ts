/** World map (choropleth): rows -> matched countries -> ECharts option. Pure. */
import type { EChartsOption } from "echarts";
import type { ChartDataResult, Dataset } from "../../api.ts";
import { metricFormatter } from "../display.ts";
import { scaleColors } from "../distribution.ts";
import { toNumber } from "../format.ts";
import { dimensionLabel, metricLabel, metricName, type ChartState } from "../model.ts";
import type { DrawContext } from "../options.ts";
import { matchRows, type CountryMatch } from "./countryMatch.ts";

export const WORLD_MAP = "vita-world";
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Each row's country as shown (dataset value labels first, so they can fix bad names), matched. */
export function worldMatch(state: ChartState, result: ChartDataResult, dataset: Dataset | null): CountryMatch {
  const dim = state.query.dimensions[0] ?? "";
  const metric = state.query.metrics[0];
  const di = result.columns.findIndex((c) => c.name === dim);
  const mi = metric ? result.columns.findIndex((c) => c.name === metricName(metric)) : -1;
  return matchRows(
    result.rows
      .filter((row) => row[di] !== null && row[di] !== undefined && String(row[di]).trim() !== "")
      .map((row) => ({ name: dimensionLabel(row[di], dim, dataset), value: toNumber(row[mi]) })),
  );
}

/** "3 values couldn't be matched: Yugoslavia, Runion, Narnia" (null when all matched). */
export function unmatchedNotice(unmatched: string[], shown = 8): string | null {
  if (unmatched.length === 0) return null;
  const list = unmatched.slice(0, shown).join(", ") + (unmatched.length > shown ? `, +${unmatched.length - shown} more` : "");
  return `${unmatched.length} ${unmatched.length === 1 ? "value" : "values"} couldn't be matched to a country: ${list}.`;
}

export function worldMapOption(state: ChartState, match: CountryMatch, dataset: Dataset | null, ctx: DrawContext = {}): EChartsOption {
  const metric = state.query.metrics[0];
  const format = metric ? metricFormatter(state.display, metric, dataset) : (v: unknown) => String(v);
  const values = [...match.values.values()];
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const colors = scaleColors(ctx);
  const t = ctx.tokens ?? {};
  return {
    tooltip: {
      trigger: "item",
      formatter: (params: unknown) => {
        const p = params as { name: string; value: unknown; data?: { country?: string; names?: string[] } };
        const name = p.data?.country ?? p.name;
        if (p.value === undefined || Number.isNaN(p.value)) return `${escapeHtml(name)}<br/><i>No data</i>`;
        const also = p.data?.names && p.data.names.length > 1 ? `<br/><i>${escapeHtml(p.data.names.join(" + "))}</i>` : "";
        return `${escapeHtml(name)}<br/><b>${escapeHtml(format(p.value))}</b>${also}`;
      },
    },
    visualMap: {
      type: "continuous",
      min,
      max: max > min ? max : min + 1,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemWidth: 12,
      itemHeight: 140,
      formatter: (v: unknown) => format(v),
      text: [format(max > min ? max : min + 1), format(min)],
      ...(colors ? { inRange: { color: colors } } : {}),
      ...(ctx.labelColor ? { textStyle: { color: ctx.labelColor } } : {}),
    },
    series: [
      {
        type: "map",
        map: WORLD_MAP,
        nameProperty: "key",
        name: metric ? metricLabel(metric, dataset) : "",
        roam: false,
        top: 8,
        bottom: 40,
        left: "center",
        aspectScale: 0.85,
        // Countries without data: the card color with an outline (so the faintest value still
        // reads as "some", never as "none").
        itemStyle: { ...(t.surface ? { areaColor: t.surface } : {}), ...(t.border ? { borderColor: t.border } : {}), borderWidth: 0.8 },
        emphasis: { label: { show: false }, itemStyle: { ...(t.accent ? { areaColor: t.accent } : {}) } },
        select: { disabled: true },
        data: [...match.values.entries()].map(([key, value]) => ({ name: key, value, names: match.labels.get(key) ?? [], country: match.labels.get(key)?.[0] })),
      },
    ],
  };
}
