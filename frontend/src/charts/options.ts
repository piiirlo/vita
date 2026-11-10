/** Result rows -> ECharts options for bar, line and the big-number trend. Pure functions. */
import type { EChartsOption, SeriesOption } from "echarts";
import type { ChartDataResult, Dataset, MetricRef } from "../api.ts";
import { hasTimeAxis, incompleteBuckets, metricFormatter, planLabels, type Coverage, type LabelPlan } from "./display.ts";
import { categoryLabel, toNumber } from "./format.ts";
import { dimensionLabel, metricLabel, metricName, type ChartState, type DisplayOptions } from "./model.ts";

export type PivotSeries = {
  /** Legend name, e.g. "Revenue" or "web · Revenue" (before renames). */
  name: string;
  metric: MetricRef;
  values: (number | null)[];
};

export type Pivoted = {
  /** Raw x values (time buckets or dimension values), in display order. */
  categories: unknown[];
  series: PivotSeries[];
};

const key = (v: unknown) => (v === null || v === undefined ? "\u0000null" : String(v));

/** Rows like [x, series?, metric1, metric2, ...] -> one series per (series value x metric). */
export function pivot(
  result: ChartDataResult,
  xColumn: string,
  seriesColumn: string | null,
  metrics: MetricRef[],
  dataset: Dataset | null,
): Pivoted {
  const index = (name: string) => result.columns.findIndex((c) => c.name === name);
  const xi = index(xColumn);
  const si = seriesColumn ? index(seriesColumn) : -1;
  const metricIndexes = metrics.map((m) => index(metricName(m)));

  const categories: unknown[] = [];
  const categoryPos = new Map<string, number>();
  const seriesValues: unknown[] = [];
  const seriesPos = new Map<string, number>();
  for (const row of result.rows) {
    const x = row[xi];
    if (!categoryPos.has(key(x))) {
      categoryPos.set(key(x), categories.length);
      categories.push(x);
    }
    const s = si >= 0 ? row[si] : null;
    if (!seriesPos.has(key(s))) {
      seriesPos.set(key(s), seriesValues.length);
      seriesValues.push(s);
    }
  }

  const series: PivotSeries[] = [];
  for (const s of seriesValues) {
    metrics.forEach((metric) => {
      const label = metricLabel(metric, dataset);
      const shown = dimensionLabel(s, seriesColumn, dataset);
      const name = si < 0 ? label : metrics.length > 1 ? `${shown} · ${label}` : shown;
      series.push({ name, metric, values: categories.map(() => null) });
    });
  }
  for (const row of result.rows) {
    const c = categoryPos.get(key(row[xi]))!;
    const s = seriesPos.get(key(si >= 0 ? row[si] : null))!;
    metricIndexes.forEach((mi, m) => {
      series[s * metrics.length + m]!.values[c] = toNumber(row[mi]);
    });
  }
  return { categories, series };
}

/** Bar sorting: by the total of the first metric (largest first), or by label. */
export function sortCategories(p: Pivoted, by: "value" | "label", firstMetric: MetricRef): Pivoted {
  const order = p.categories.map((_, i) => i);
  if (by === "value") {
    const name = metricName(firstMetric);
    const total = (i: number) =>
      p.series.filter((s) => metricName(s.metric) === name).reduce((sum, s) => sum + (s.values[i] ?? 0), 0);
    order.sort((a, b) => total(b) - total(a));
  } else {
    order.sort((a, b) => compareLabels(p.categories[a], p.categories[b]));
  }
  return {
    categories: order.map((i) => p.categories[i]),
    series: p.series.map((s) => ({ ...s, values: order.map((i) => s.values[i] ?? null) })),
  };
}

function compareLabels(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return 1; // (empty) last
  if (b === null || b === undefined) return -1;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return String(a).localeCompare(String(b));
}

/** Series order: as the data came (default), biggest total first, or by name. */
export function sortSeries(series: PivotSeries[], by: DisplayOptions["series_sort"]): PivotSeries[] {
  if (!by || by === "default") return series;
  const total = (s: PivotSeries) => s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  return [...series].sort((a, b) => (by === "value" ? total(b) - total(a) : compareLabels(a.name, b.name)));
}

/** The shown name of a series (renamed in Customize, else its own). */
export const seriesLabel = (name: string, display: DisplayOptions) => display.series_labels?.[name]?.trim() || name;

/** Things the chart needs from the page: real colors, its size and where the data is. */
export type DrawContext = {
  /** Resolved --series-N colors (needed for single colors and incomplete periods). */
  colors?: string[];
  /** Text color for value labels. */
  labelColor?: string;
  /** Width of the chart in px (unknown: every label kept, unrotated). */
  width?: number;
  /** Time range and data extent, to mark incomplete first / last periods. */
  coverage?: Coverage;
};

type TooltipItem = {
  axisValueLabel?: string;
  name?: string;
  dataIndex: number;
  seriesId?: string;
  seriesIndex: number;
  marker: string;
  seriesName: string;
  value: unknown;
};

const PARTIAL_ID = "partial:";

function tooltipFormatter(formatters: ((v: unknown) => string)[], partial: Set<number>, titles?: string[]) {
  return (params: unknown): string => {
    const items = (Array.isArray(params) ? params : [params]) as TooltipItem[];
    const first = items[0];
    const title = (first && titles?.[first.dataIndex]) ?? first?.axisValueLabel ?? first?.name ?? "";
    const note = first && partial.has(first.dataIndex) ? ` <i>· Incomplete period</i>` : "";
    const lines = items
      .filter((i) => i.value !== null && i.value !== undefined && !i.seriesId?.startsWith(PARTIAL_ID))
      .map((i) => {
        const format = formatters[i.seriesIndex] ?? ((v: unknown) => String(v));
        return `${i.marker}${escapeHtml(i.seriesName)}: <b>${escapeHtml(format(i.value))}</b>`;
      });
    return [escapeHtml(title) + note, ...lines].join("<br/>");
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const GRID = { left: 16, right: 24, top: 48, bottom: 16, containLabel: true };
/** So two or three bars don't fit the whole chart. */
export const BAR_MAX_WIDTH = 48;
/** Lighter bars for incomplete periods (with a dashed outline, so it isn't color alone). */
const PARTIAL_OPACITY = 0.45;

export type CartesianLayout = { option: EChartsOption; labels: LabelPlan; seriesNames: string[]; partial: Set<number> };

/** The ECharts option for a bar / line chart, plus what the page shows around it. */
export function cartesianLayout(state: ChartState, result: ChartDataResult, dataset: Dataset | null, ctx: DrawContext = {}): CartesianLayout {
  const { query, display, vizType } = state;
  const grain = query.time?.grain ?? null;
  const timeAxis = hasTimeAxis(state);
  const xColumn = timeAxis ? query.time!.column! : (query.dimensions[0] ?? "");
  let pivoted = pivot(result, xColumn, query.series, query.metrics, dataset);
  if (vizType === "bar" && !timeAxis && query.metrics[0]) {
    pivoted = sortCategories(pivoted, display.sort ?? "value", query.metrics[0]);
  }
  const ordered = sortSeries(pivoted.series, display.series_sort);
  const partial = timeAxis ? incompleteBuckets(pivoted.categories, grain, ctx.coverage ?? {}) : new Set<number>();

  const labels = pivoted.categories.map((c) => (timeAxis ? categoryLabel(c, grain) : dimensionLabel(c, xColumn, dataset)));
  const horizontal = vizType === "bar" && Boolean(display.horizontal);
  const plan = planLabels(labels, ctx.width, horizontal);
  const categoryAxis = {
    type: "category" as const,
    data: labels,
    axisTick: { alignWithLabel: true },
    axisLabel: {
      interval: plan.interval,
      rotate: plan.rotate,
      width: plan.maxWidth,
      overflow: "truncate" as const,
      ellipsis: "…",
      hideOverlap: false,
    },
  };

  const firstMetric = query.metrics[0];
  const axisFormat = firstMetric ? metricFormatter(display, firstMetric, dataset) : (v: unknown) => String(v);
  // Say what is measured: with one metric the value axis is titled with its label (several
  // metrics are told apart by the legend instead).
  const axisTitle =
    display.axis_titles !== false && query.metrics.length === 1 ? metricLabel(query.metrics[0]!, dataset) : undefined;
  const valueAxis = {
    type: "value" as const,
    axisLabel: { formatter: (v: number) => axisFormat(v) },
    ...(axisTitle === undefined
      ? {}
      : horizontal
        ? { name: axisTitle, nameLocation: "middle" as const, nameGap: 28 }
        : { name: axisTitle, nameLocation: "end" as const, nameTextStyle: { align: "left" as const } }),
  };

  const several = ordered.length > 1;
  const palette = ctx.colors?.filter(Boolean) ?? [];
  const single = !several && display.color ? ctx.colors?.[display.color - 1] : undefined;
  const colorOf = (i: number): string | undefined => single ?? (palette.length ? palette[i % palette.length] : undefined);
  const formatters = ordered.map((s) => metricFormatter(display, s.metric, dataset));
  const names = ordered.map((s) => seriesLabel(s.name, display));

  const valueLabel = (i: number) =>
    display.value_labels
      ? {
          show: true,
          position: vizType === "bar" ? (display.stacked ? ("inside" as const) : horizontal ? ("right" as const) : ("top" as const)) : ("top" as const),
          formatter: (p: { value: unknown }) => formatters[i]!(p.value),
          fontSize: 11,
          ...(ctx.labelColor && !(vizType === "bar" && display.stacked) ? { color: ctx.labelColor } : {}),
        }
      : undefined;

  const series: SeriesOption[] = [];
  // The formatter of each pushed series (twins included), by series index.
  const seriesFormatters: ((v: unknown) => string)[] = [];
  ordered.forEach((s, i) => {
    const color = colorOf(i);
    if (vizType === "bar") {
      series.push({
        type: "bar",
        name: names[i],
        data: s.values.map((v, ci) =>
          partial.has(ci)
            ? {
                value: v,
                itemStyle: { opacity: PARTIAL_OPACITY, borderType: "dashed", borderWidth: 1.5, ...(color ? { borderColor: color } : {}) },
              }
            : v,
        ),
        stack: display.stacked ? "total" : undefined,
        barMaxWidth: BAR_MAX_WIDTH,
        emphasis: { focus: "series" },
        label: valueLabel(i),
        ...(color ? { itemStyle: { color } } : {}),
      });
      seriesFormatters.push(formatters[i]!);
      return;
    }
    // Line: incomplete first / last segments are drawn dotted by a twin series (same name, so
    // the legend shows one entry and toggles both).
    const last = s.values.length - 1;
    const solid = s.values.map((v, ci) => ((partial.has(0) && ci === 0) || (partial.has(last) && ci === last) ? null : v));
    series.push({
      type: "line",
      name: names[i],
      data: partial.size && s.values.length > 1 ? solid : s.values,
      showSymbol: Boolean(display.show_points),
      symbolSize: 6,
      connectNulls: false,
      emphasis: { focus: "series" },
      label: valueLabel(i),
      ...(color ? { itemStyle: { color }, lineStyle: { color } } : {}),
    });
    seriesFormatters.push(formatters[i]!);
    if (partial.size && s.values.length > 1) {
      const dotted = s.values.map((v, ci) => {
        const nearFirst = partial.has(0) && ci <= 1;
        const nearLast = partial.has(last) && ci >= last - 1;
        return nearFirst || nearLast ? v : null;
      });
      series.push({
        type: "line",
        id: `${PARTIAL_ID}${i}`,
        name: names[i],
        data: dotted,
        showSymbol: Boolean(display.show_points),
        symbolSize: 6,
        connectNulls: false,
        lineStyle: { type: "dotted", width: 2.4, ...(color ? { color } : {}) },
        ...(color ? { itemStyle: { color } } : {}),
        // Labels only at the incomplete points (the solid line has the others).
        label: display.value_labels
          ? { ...valueLabel(i), formatter: (p: { value: unknown; dataIndex: number }) => (partial.has(p.dataIndex) ? formatters[i]!(p.value) : "") }
          : undefined,
        z: 1,
      });
      seriesFormatters.push(formatters[i]!);
    }
  });

  const legendPosition = display.legend ?? "top";
  const showLegend = several && legendPosition !== "none";
  const legend = !showLegend
    ? undefined
    : legendPosition === "right"
      ? { type: "scroll" as const, orient: "vertical" as const, right: 0, top: "middle" as const }
      : legendPosition === "bottom"
        ? { type: "scroll" as const, bottom: 0 }
        : { type: "scroll" as const, top: 0 };

  const option: EChartsOption = {
    grid: {
      ...GRID,
      // Room for the legend and/or the axis title.
      top: showLegend && legendPosition === "top" ? 48 : axisTitle && !horizontal ? 36 : 24,
      bottom: (showLegend && legendPosition === "bottom" ? 36 : GRID.bottom) + (axisTitle && horizontal ? 20 : 0),
      right: showLegend && legendPosition === "right" ? 160 : GRID.right,
    },
    legend,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: vizType === "bar" ? "shadow" : "line" },
      // The full category name, even when the axis label is cut.
      formatter: tooltipFormatter(seriesFormatters, partial, labels),
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series,
  };
  return { option, labels: plan, seriesNames: ordered.map((s) => s.name), partial };
}

export function cartesianOption(state: ChartState, result: ChartDataResult, dataset: Dataset | null, ctx: DrawContext = {}): EChartsOption {
  return cartesianLayout(state, result, dataset, ctx).option;
}

/** Small trend line under a big number (incomplete first / last periods dotted). */
export function sparklineOption(state: ChartState, trend: ChartDataResult, dataset: Dataset | null, ctx: DrawContext = {}): EChartsOption {
  const metric = state.query.metrics[0]!;
  const grain = state.query.time?.grain ?? null;
  const buckets = trend.rows.map((r) => r[0]);
  const values = trend.rows.map((r) => toNumber(r[1]));
  const labels = buckets.map((b) => categoryLabel(b, grain));
  const partial = incompleteBuckets(buckets, grain, ctx.coverage ?? {});
  const format = metricFormatter(state.display, metric, dataset);
  const last = values.length - 1;
  const solid = values.map((v, i) => ((partial.has(0) && i === 0) || (partial.has(last) && i === last) ? null : v));
  const dotted = values.map((v, i) => ((partial.has(0) && i <= 1) || (partial.has(last) && i >= last - 1) ? v : null));
  const name = metricLabel(metric, dataset);
  const color = ctx.colors?.[0];
  const series: SeriesOption[] = [
    {
      type: "line",
      name,
      data: partial.size && values.length > 1 ? solid : values,
      showSymbol: false,
      smooth: true,
      lineStyle: { width: 2, ...(color ? { color } : {}) },
      areaStyle: { opacity: 0.12 },
      ...(color ? { itemStyle: { color } } : {}),
    },
  ];
  if (partial.size && values.length > 1) {
    series.push({
      type: "line",
      id: `${PARTIAL_ID}0`,
      name,
      data: dotted,
      showSymbol: false,
      smooth: true,
      lineStyle: { width: 2, type: "dotted", ...(color ? { color } : {}) },
      ...(color ? { itemStyle: { color } } : {}),
    });
  }
  return {
    grid: { left: 4, right: 4, top: 6, bottom: 4 },
    xAxis: { type: "category", data: labels, show: false, boundaryGap: false },
    yAxis: { type: "value", show: false, scale: true },
    tooltip: { trigger: "axis", formatter: tooltipFormatter([format, format], partial, labels) },
    series,
  };
}

/** The original names of a bar / line result's series (what Customize can rename). */
export function seriesNamesOf(state: ChartState, result: ChartDataResult, dataset: Dataset | null): string[] {
  if (state.vizType === "pie") return pieSlices(state, result, dataset).map((s) => s.original);
  if (state.vizType !== "bar" && state.vizType !== "line") return [];
  const xColumn = hasTimeAxis(state) ? state.query.time!.column! : (state.query.dimensions[0] ?? "");
  return pivot(result, xColumn, state.query.series, state.query.metrics, dataset).series.map((s) => s.name);
}

// ---------- pie / donut ----------

/** The result column the backend sets to 1 on the "Other" row (every slice outside the top N). */
export const OTHER_COLUMN = "__other";
export const OTHER_LABEL = "Other";

export type PieSlice = { name: string; original: string; value: number | null; other: boolean };

/** Result rows -> slices, labelled (value labels, renames), sorted, "Other" last. */
export function pieSlices(state: ChartState, result: ChartDataResult, dataset: Dataset | null): PieSlice[] {
  const dim = state.query.dimensions[0] ?? "";
  const metric = state.query.metrics[0];
  const index = (name: string) => result.columns.findIndex((c) => c.name === name);
  const di = index(dim);
  const oi = index(OTHER_COLUMN);
  const mi = metric ? index(metricName(metric)) : -1;
  const slices = result.rows.map((row) => {
    const other = oi >= 0 && toNumber(row[oi]) === 1;
    const original = other ? OTHER_LABEL : dimensionLabel(row[di], dim, dataset);
    return { original, name: seriesLabel(original, state.display), value: toNumber(row[mi]), other };
  });
  const by = state.display.sort ?? "value";
  const main = slices.filter((s) => !s.other);
  main.sort((a, b) => (by === "value" ? (b.value ?? 0) - (a.value ?? 0) : compareLabels(a.name, b.name)));
  return [...main, ...slices.filter((s) => s.other)];
}

/** Pie or donut. `total`: the metric over everything, shown in the donut's middle. */
export function pieOption(
  state: ChartState,
  result: ChartDataResult,
  dataset: Dataset | null,
  ctx: DrawContext & { total?: ChartDataResult | null; centerColor?: string; mutedColor?: string } = {},
): EChartsOption {
  const { display } = state;
  const metric = state.query.metrics[0];
  const format = metric ? metricFormatter(display, metric, dataset) : (v: unknown) => String(v);
  const slices = pieSlices(state, result, dataset);
  const palette = ctx.colors?.filter(Boolean) ?? [];
  const donut = Boolean(display.donut);
  const legendPosition = display.legend ?? "right";
  const legend =
    legendPosition === "none"
      ? undefined
      : legendPosition === "right"
        ? { type: "scroll" as const, orient: "vertical" as const, right: 0, top: "middle" as const }
        : legendPosition === "bottom"
          ? { type: "scroll" as const, bottom: 0 }
          : { type: "scroll" as const, top: 0 };
  const center: [string, string] = [legendPosition === "right" ? "40%" : "50%", legendPosition === "top" ? "55%" : legendPosition === "bottom" ? "45%" : "50%"];
  const totalValue = ctx.total?.rows[0]?.[0];
  return {
    legend,
    tooltip: {
      trigger: "item",
      formatter: (p: unknown) => {
        const item = p as { name: string; value: unknown; percent: number; marker: string };
        return `${item.marker}${escapeHtml(item.name)}: <b>${escapeHtml(format(item.value))}</b> (${item.percent.toFixed(1)}%)`;
      },
    },
    title:
      donut && ctx.total && totalValue !== undefined
        ? {
            text: format(totalValue),
            subtext: metric ? metricLabel(metric, dataset) : "",
            left: center[0],
            top: center[1],
            textAlign: "center",
            textVerticalAlign: "middle",
            itemGap: 4,
            textStyle: { fontSize: 22, fontWeight: 500, ...(ctx.centerColor ? { color: ctx.centerColor } : {}) },
            subtextStyle: { fontSize: 12, ...(ctx.mutedColor ? { color: ctx.mutedColor } : {}) },
          }
        : undefined,
    series: [
      {
        type: "pie",
        name: metric ? metricLabel(metric, dataset) : "",
        radius: donut ? ["52%", "78%"] : [0, "78%"],
        center,
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "transparent", borderWidth: 2, borderRadius: donut ? 6 : 3 },
        label: display.value_labels
          ? {
              show: true,
              formatter: (params: unknown) => {
                const p = params as { name: string; value: unknown; percent: number };
                return `${p.name}\n${format(p.value)} · ${p.percent.toFixed(0)}%`;
              },
              fontSize: 11,
              ...(ctx.labelColor ? { color: ctx.labelColor } : {}),
            }
          : { show: false },
        labelLine: { show: Boolean(display.value_labels) },
        emphasis: { scaleSize: 6 },
        data: slices.map((s, i) => {
          // "Other" in the quiet stone color; slices in palette order.
          const color = palette.length ? (s.other ? palette[8 % palette.length] : palette[i % palette.length]) : undefined;
          return { name: s.name, value: s.value ?? 0, ...(color ? { itemStyle: { color } } : {}) };
        }),
      },
    ],
  };
}
