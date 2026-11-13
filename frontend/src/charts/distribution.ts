/** Heatmap, scatter / bubble and histogram: result rows -> ECharts options. Pure functions. */
import type { BarSeriesOption, EChartsOption, SeriesOption } from "echarts";
import type { ChartDataResult, Dataset } from "../api.ts";
import { incompleteBuckets, metricFormatter, type Coverage } from "./display.ts";
import { isGrain, isTimePart, PART_DOMAIN, splitDim } from "./dimensions.ts";
import { formatNumber, toNumber } from "./format.ts";
import { columnLabel, dimensionLabel, metricLabel, metricName, type ChartState } from "./model.ts";
import { readableOn } from "./moreCharts.ts";
import { seriesLabel, toneColors, type DrawContext } from "./options.ts";
import { colorRules, ruleFor, ruleMarker, ruledItem } from "./colorRules.ts";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const columnIndex = (result: ChartDataResult, name: string) => result.columns.findIndex((c) => c.name === name);
const keyOf = (v: unknown) => (v === null || v === undefined ? "\u0000" : String(v));

function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  const na = typeof a === "number" ? a : null;
  const nb = typeof b === "number" ? b : null;
  if (na !== null && nb !== null) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** Low -> high colors of a continuous scale: from the sunken surface to the two olives,
 * ordered by contrast with the card so "more" always stands out more (both themes). */
export function scaleColors(ctx: DrawContext): string[] | undefined {
  const [, olive, darkOlive] = ctx.colors ?? [];
  // The faint olive tint (--heat-2): "a little" reads as a little, never as "no data" (which
  // stays the plain card color).
  const low = ctx.tokens?.tint;
  if (!low || !olive || !darkOlive) return undefined;
  const surface = ctx.tokens?.surface;
  const strongest = readableOn(surface, [olive, darkOlive]);
  return strongest === olive ? [low, darkOlive, olive] : [low, olive, darkOlive];
}

function visualMap(min: number, max: number, format: (v: unknown) => string, ctx: DrawContext) {
  const colors = scaleColors(ctx);
  return {
    type: "continuous" as const,
    min,
    max: max > min ? max : min + 1,
    calculable: false,
    text: [format(max > min ? max : min + 1), format(min)],
    orient: "horizontal" as const,
    left: "center",
    bottom: 0,
    itemWidth: 12,
    itemHeight: 140,
    formatter: (v: unknown) => format(v),
    ...(colors ? { inRange: { color: colors } } : {}),
    ...(ctx.labelColor ? { textStyle: { color: ctx.labelColor } } : {}),
  };
}

// ---------- heatmap ----------

export type HeatmapAxis = { ref: string; values: unknown[]; labels: string[]; partial: Set<number> };

/** One axis of a heatmap: every value of a time part (Monday first), else the values in the
 * data's order; date buckets mark their incomplete first / last periods. */
export function heatmapAxis(result: ChartDataResult, ref: string, dataset: Dataset | null, coverage: Coverage | null): HeatmapAxis {
  const { part } = splitDim(ref, dataset);
  const i = columnIndex(result, ref);
  let values: unknown[];
  if (isTimePart(part)) {
    values = PART_DOMAIN[part];
  } else {
    const seen = new Set<string>();
    values = [];
    for (const row of result.rows) {
      if (!seen.has(keyOf(row[i]))) {
        seen.add(keyOf(row[i]));
        values.push(row[i]);
      }
    }
    // Rows come sorted by the first dimension only: put this axis in order too (dates and
    // numbers by value, text alphabetically, empty last).
    values.sort(compareValues);
  }
  const partial = isGrain(part) && coverage ? incompleteBuckets(values, part, coverage) : new Set<number>();
  return { ref, values, labels: values.map((v) => dimensionLabel(v, ref, dataset)), partial };
}

export function heatmapOption(
  state: ChartState,
  result: ChartDataResult,
  dataset: Dataset | null,
  ctx: DrawContext & { coverageFor?: (ref: string) => Coverage | null } = {},
): { option: EChartsOption; partial: boolean } {
  const [rowRef = "", colRef = ""] = state.query.dimensions;
  const metric = state.query.metrics[0];
  const format = metric ? metricFormatter(state.display, metric, dataset) : (v: unknown) => String(v);
  const rows = heatmapAxis(result, rowRef, dataset, ctx.coverageFor?.(rowRef) ?? null);
  const cols = heatmapAxis(result, colRef, dataset, ctx.coverageFor?.(colRef) ?? null);
  const ri = columnIndex(result, rowRef);
  const ci = columnIndex(result, colRef);
  const mi = metric ? columnIndex(result, metricName(metric)) : -1;
  const rowPos = new Map(rows.values.map((v, i) => [keyOf(v), i]));
  const colPos = new Map(cols.values.map((v, i) => [keyOf(v), i]));
  const edge = ctx.tokens?.text;

  let min = Infinity;
  let max = -Infinity;
  const data = result.rows.flatMap((row) => {
    const x = colPos.get(keyOf(row[ci]));
    const y = rowPos.get(keyOf(row[ri]));
    const v = toNumber(row[mi]);
    if (x === undefined || y === undefined || v === null) return [];
    min = Math.min(min, v);
    max = Math.max(max, v);
    const incomplete = cols.partial.has(x) || rows.partial.has(y);
    // Incomplete periods: a dashed edge (not color alone) and a note in the tooltip.
    return [incomplete ? { value: [x, y, v], incomplete: true, itemStyle: { borderType: "dashed" as const, borderWidth: 1.5, ...(edge ? { borderColor: edge } : {}) } } : [x, y, v]];
  });
  if (!Number.isFinite(min)) min = max = 0;
  const axis = (a: HeatmapAxis, title: string) => ({
    type: "category" as const,
    data: a.labels,
    splitArea: { show: false },
    axisTick: { show: false },
    axisLine: { show: false },
    ...(state.display.axis_titles !== false ? { name: title, nameLocation: "middle" as const, nameGap: 30 } : {}),
  });
  const option: EChartsOption = {
    grid: { left: 16, right: 16, top: 12, bottom: 60, containLabel: true },
    tooltip: {
      formatter: (params: unknown) => {
        const p = params as { value: [number, number, number]; data: { incomplete?: boolean } | unknown[] };
        const [x, y, v] = p.value;
        const note = !Array.isArray(p.data) && p.data.incomplete ? " <i>· Incomplete period</i>" : "";
        return `${escapeHtml(rows.labels[y] ?? "")} · ${escapeHtml(cols.labels[x] ?? "")}${note}<br/><b>${escapeHtml(format(v))}</b>`;
      },
    },
    xAxis: { ...axis(cols, columnLabel(colRef, dataset)), position: "bottom" as const },
    yAxis: { ...axis(rows, columnLabel(rowRef, dataset)), inverse: true },
    visualMap: visualMap(min, max, format, ctx),
    series: [
      {
        type: "heatmap",
        name: metric ? metricLabel(metric, dataset) : "",
        data,
        itemStyle: { borderColor: ctx.tokens?.surface ?? "transparent", borderWidth: 2, borderRadius: 3 },
        label: state.display.value_labels
          ? {
              show: true,
              fontSize: 11,
              formatter: (p: unknown) => format((p as { value: [number, number, number] }).value[2]),
              ...(edge ? { color: edge, textBorderColor: ctx.tokens?.surface, textBorderWidth: 2 } : {}),
            }
          : { show: false },
        emphasis: { itemStyle: { ...(ctx.tokens?.accent ? { borderColor: ctx.tokens.accent } : {}), borderWidth: 2 } },
      },
    ],
  };
  return { option, partial: rows.partial.size + cols.partial.size > 0 };
}

// ---------- scatter / bubble ----------

/** Colors beyond this many become one "Other" group (the stone color, palette 9, is Other's). */
export const SCATTER_MAX_COLORS = 9;
const SIZE_RANGE: [number, number] = [6, 34];

export type ScatterPoint = { name: string; x: number; y: number; size: number | null; group: string };

export function scatterPoints(state: ChartState, result: ChartDataResult, dataset: Dataset | null): { points: ScatterPoint[]; groups: string[] } {
  const { dimensions, metrics, series } = state.query;
  const point = dimensions[0] ?? "";
  const pi = columnIndex(result, point);
  const si = series ? columnIndex(result, series) : -1;
  const [xi, yi, zi] = metrics.map((m) => columnIndex(result, metricName(m)));
  const all: ScatterPoint[] = [];
  for (const row of result.rows) {
    const x = toNumber(row[xi!]);
    const y = toNumber(row[yi!]);
    if (x === null || y === null) continue;
    all.push({
      name: dimensionLabel(row[pi], point, dataset),
      x,
      y,
      size: zi !== undefined ? toNumber(row[zi]) : null,
      group: si >= 0 ? seriesLabel(dimensionLabel(row[si], series, dataset), state.display) : "",
    });
  }
  // The biggest color groups keep their own color; the rest is "Other".
  const counts = new Map<string, number>();
  for (const p of all) counts.set(p.group, (counts.get(p.group) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const kept = new Set(ranked.slice(0, SCATTER_MAX_COLORS));
  const groups = ranked.filter((g) => kept.has(g));
  if (ranked.length > SCATTER_MAX_COLORS) {
    for (const p of all) if (!kept.has(p.group)) p.group = "Other";
    groups.push("Other");
  }
  return { points: all, groups };
}

export function scatterOption(state: ChartState, result: ChartDataResult, dataset: Dataset | null, ctx: DrawContext = {}): EChartsOption {
  const { metrics, series } = state.query;
  const [xm, ym, zm] = metrics;
  const fx = xm ? metricFormatter(state.display, xm, dataset) : String;
  const fy = ym ? metricFormatter(state.display, ym, dataset) : String;
  const fz = zm ? metricFormatter(state.display, zm, dataset) : null;
  const { points, groups } = scatterPoints(state, result, dataset);
  const sizes = points.map((p) => p.size).filter((s): s is number => s !== null);
  const [smin, smax] = [Math.min(...sizes), Math.max(...sizes)];
  const sizeOf = (s: number | null) => {
    if (s === null || !zm || !(smax > smin)) return zm ? (SIZE_RANGE[0] + SIZE_RANGE[1]) / 2 : 9;
    // Area, not radius, grows with the value.
    const t = Math.sqrt((s - smin) / (smax - smin));
    return SIZE_RANGE[0] + t * (SIZE_RANGE[1] - SIZE_RANGE[0]);
  };
  const palette = ctx.colors?.filter(Boolean) ?? [];
  const showLegend = Boolean(series) && (state.display.legend ?? "top") !== "none";
  // Palette colors in order, skipping the stone one (Other's); or the group's own color.
  const groupColor = (i: number) => palette[i >= 8 ? i + 1 : i];
  // Conditional colors on the y value (with ▲ / ▼ and the value as the point's label).
  const rules = ym ? colorRules(state.display) : [];
  const tones = toneColors(ctx);
  const out: SeriesOption[] = groups.map((group, i) => {
    const other = group === "Other";
    const picked = state.display.series_colors?.[group];
    const color = palette.length ? (other ? palette[8 % palette.length] : picked ? palette[picked - 1] : groupColor(i % 9)) : undefined;
    return {
      type: "scatter",
      name: group || (ym ? metricLabel(ym, dataset) : ""),
      data: points
        .filter((p) => p.group === group)
        .map((p) => {
          const rule = ym ? ruleFor(p.y, metricName(ym), rules) : null;
          const point = { name: p.name, value: [p.x, p.y, p.size], symbolSize: sizeOf(p.size) };
          if (!rule) return point;
          const tone = tones[rule.tone];
          return {
            ...point,
            itemStyle: { opacity: 1, ...(tone ? { color: tone } : {}) },
            label: { show: true, position: "top" as const, fontSize: 11, formatter: `${ruleMarker(rule)} ${fy(p.y)}`, ...(ctx.labelColor ? { color: ctx.labelColor } : {}) },
          };
        }),
      // "Other" sits underneath, quieter.
      z: other ? 1 : 2,
      itemStyle: { opacity: other ? 0.45 : 0.8, ...(color ? { color } : {}) },
      emphasis: { focus: "series" as const, itemStyle: { opacity: 1 } },
      label: state.display.value_labels ? { show: true, position: "top" as const, fontSize: 11, formatter: "{b}", ...(ctx.labelColor ? { color: ctx.labelColor } : {}) } : undefined,
    };
  });
  const titles = state.display.axis_titles !== false;
  return {
    grid: { left: 16, right: 24, top: showLegend ? 48 : 28, bottom: titles ? 28 : 16, containLabel: true },
    legend: showLegend ? { type: "scroll", top: 0 } : undefined,
    tooltip: {
      trigger: "item",
      formatter: (params: unknown) => {
        const p = params as { name: string; seriesName: string; value: [number, number, number | null] };
        const lines = [
          `<b>${escapeHtml(p.name)}</b>${series ? ` · ${escapeHtml(p.seriesName)}` : ""}`,
          `${escapeHtml(xm ? metricLabel(xm, dataset) : "x")}: ${escapeHtml(fx(p.value[0]))}`,
          `${escapeHtml(ym ? metricLabel(ym, dataset) : "y")}: ${escapeHtml(fy(p.value[1]))}`,
        ];
        if (zm && fz) lines.push(`${escapeHtml(metricLabel(zm, dataset))}: ${escapeHtml(fz(p.value[2]))}`);
        return lines.join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      scale: true,
      axisLabel: { formatter: (v: number) => fx(v) },
      ...(titles && xm ? { name: metricLabel(xm, dataset), nameLocation: "middle" as const, nameGap: 28 } : {}),
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { formatter: (v: number) => fy(v) },
      ...(titles && ym ? { name: metricLabel(ym, dataset), nameLocation: "end" as const, nameTextStyle: { align: "left" as const } } : {}),
    },
    series: out,
  };
}

// ---------- histogram ----------

export const BIN = "__bin";
export const BIN_START = "__bin_start";
export const BIN_END = "__bin_end";

export type HistogramBin = { index: number; start: number; end: number; value: number };

/** Rows -> every bin from the first to the last (bins without rows are 0), and the metric of
 * the rows without a value (bin NULL; null when there are none). */
export function histogramBins(state: ChartState, result: ChartDataResult): { bins: HistogramBin[]; missing: number | null } {
  const metric = state.query.metrics[0];
  const [bi, si, ei] = [BIN, BIN_START, BIN_END].map((n) => columnIndex(result, n));
  const mi = metric ? columnIndex(result, metricName(metric)) : -1;
  let missing: number | null = null;
  const present = new Map<number, HistogramBin>();
  for (const row of result.rows) {
    const index = toNumber(row[bi!]);
    const value = toNumber(row[mi]) ?? 0;
    if (index === null) {
      missing = (missing ?? 0) + value;
      continue;
    }
    present.set(index, { index, start: toNumber(row[si!]) ?? 0, end: toNumber(row[ei!]) ?? 0, value });
  }
  if (present.size === 0) return { bins: [], missing };
  const any = present.values().next().value!;
  const width = state.query.bins?.width ?? null;
  const step = width ?? any.end - any.start;
  const origin = any.start - any.index * step;
  const indexes = [...present.keys()];
  // A number of bins always shows all of them; a width shows from the first to the last.
  const first = width === null ? 0 : Math.min(...indexes);
  const count = state.query.bins?.count ?? 0;
  const last = width === null ? Math.max(count - 1, ...indexes) : Math.max(...indexes);
  const bins: HistogramBin[] = [];
  for (let i = first; i <= last; i++) {
    bins.push(present.get(i) ?? { index: i, start: origin + i * step, end: origin + (i + 1) * step, value: 0 });
  }
  return { bins, missing };
}

/** "1.5 – 2" with just enough decimals for the bin width. */
export function binLabel(bin: HistogramBin): string {
  const step = Math.abs(bin.end - bin.start);
  const decimals = step > 0 ? Math.min(4, Math.max(0, Math.ceil(-Math.log10(step)) + 1)) : 2;
  const fmt = (v: number) => formatNumber(Number(v.toFixed(decimals)), decimals > 0 ? `0,0.[${"0".repeat(decimals)}]` : "0,0");
  return step > 0 ? `${fmt(bin.start)} – ${fmt(bin.end)}` : fmt(bin.start);
}

export function histogramOption(state: ChartState, result: ChartDataResult, dataset: Dataset | null, ctx: DrawContext = {}): EChartsOption {
  const metric = state.query.metrics[0];
  const format = metric ? metricFormatter(state.display, metric, dataset) : (v: unknown) => String(v);
  const { bins } = histogramBins(state, result);
  const labels = bins.map(binLabel);
  const starts = bins.map((b) => binLabel({ ...b, end: b.start + (b.end - b.start) }).split(" – ")[0]!);
  const color = state.display.color ? ctx.colors?.[state.display.color - 1] : ctx.colors?.[0];
  const titles = state.display.axis_titles !== false;
  const column = state.query.bins?.column ?? "";
  return {
    grid: { left: 16, right: 24, top: titles ? 36 : 24, bottom: titles ? 28 : 16, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const [p] = params as { dataIndex: number; value: unknown }[];
        if (!p) return "";
        const bin = bins[p.dataIndex]!;
        return `${escapeHtml(columnLabel(column, dataset))} ${escapeHtml(labels[p.dataIndex]!)}<br/><b>${escapeHtml(format(bin.value))}</b>`;
      },
    },
    xAxis: {
      type: "category",
      // Each bin's start under it (the full range is in the tooltip).
      data: starts,
      axisTick: { alignWithLabel: false },
      axisLabel: { hideOverlap: true },
      ...(titles ? { name: columnLabel(column, dataset), nameLocation: "middle" as const, nameGap: 28 } : {}),
    },
    yAxis: {
      type: "value",
      axisLabel: { formatter: (v: number) => format(v) },
      ...(titles && metric ? { name: metricLabel(metric, dataset), nameLocation: "end" as const, nameTextStyle: { align: "left" as const } } : {}),
    },
    series: [
      {
        type: "bar",
        name: metric ? metricLabel(metric, dataset) : "",
        data: bins.map((b) =>
          metric ? ruledItem(b.value, metricName(metric), colorRules(state.display), toneColors(ctx), format, null, ctx.labelColor) : b.value,
        ) as BarSeriesOption["data"],
        barCategoryGap: "6%",
        ...(color ? { itemStyle: { color, borderRadius: [2, 2, 0, 0] } } : { itemStyle: { borderRadius: [2, 2, 0, 0] } }),
        label: state.display.value_labels
          ? { show: true, position: "top" as const, fontSize: 11, formatter: (p: { value: unknown }) => format(p.value), ...(ctx.labelColor ? { color: ctx.labelColor } : {}) }
          : undefined,
      },
    ],
  };
}
