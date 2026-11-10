/** Result rows -> ECharts options for bar, line and the big-number trend. Pure functions. */
import type { EChartsOption, SeriesOption } from "echarts";
import type { ChartDataResult, Dataset, MetricRef } from "../api.ts";
import { categoryLabel, formatNumber, toNumber } from "./format.ts";
import { metricFormat, metricLabel, metricName, type ChartState } from "./model.ts";

export type PivotSeries = {
  /** Legend name, e.g. "Revenue" or "web · Revenue". */
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
      const name = si < 0 ? label : metrics.length > 1 ? `${categoryLabel(s)} · ${label}` : categoryLabel(s);
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
    const compare = (a: unknown, b: unknown) => {
      if (a === null || a === undefined) return 1; // (empty) last
      if (b === null || b === undefined) return -1;
      const na = toNumber(a);
      const nb = toNumber(b);
      if (na !== null && nb !== null) return na - nb;
      return String(a).localeCompare(String(b));
    };
    order.sort((a, b) => compare(p.categories[a], p.categories[b]));
  }
  return {
    categories: order.map((i) => p.categories[i]),
    series: p.series.map((s) => ({ ...s, values: order.map((i) => s.values[i] ?? null) })),
  };
}

function tooltipFormatter(series: PivotSeries[], dataset: Dataset | null) {
  return (params: unknown): string => {
    const items = (Array.isArray(params) ? params : [params]) as {
      axisValueLabel?: string;
      name?: string;
      seriesIndex: number;
      marker: string;
      seriesName: string;
      value: unknown;
    }[];
    const title = items[0]?.axisValueLabel ?? items[0]?.name ?? "";
    const lines = items
      .filter((i) => i.value !== null && i.value !== undefined)
      .map((i) => {
        const metric = series[i.seriesIndex]?.metric;
        const value = formatNumber(i.value, metric ? metricFormat(metric, dataset) : null);
        return `${i.marker}${escapeHtml(i.seriesName)}: <b>${escapeHtml(value)}</b>`;
      });
    return [escapeHtml(title), ...lines].join("<br/>");
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const GRID = { left: 16, right: 24, top: 48, bottom: 16, containLabel: true };
/** So two or three bars don't fill the whole chart. */
export const BAR_MAX_WIDTH = 48;

export function cartesianOption(
  state: ChartState,
  result: ChartDataResult,
  dataset: Dataset | null,
): EChartsOption {
  const { query, display, vizType } = state;
  const grain = query.time?.grain ?? null;
  const timeAxis = Boolean(grain && query.time?.column) && query.dimensions.length === 0;
  const xColumn = timeAxis ? query.time!.column! : (query.dimensions[0] ?? "");
  let pivoted = pivot(result, xColumn, query.series, query.metrics, dataset);
  if (vizType === "bar" && !timeAxis && query.metrics[0]) {
    pivoted = sortCategories(pivoted, display.sort ?? "value", query.metrics[0]);
  }

  const labels = pivoted.categories.map((c) => categoryLabel(c, timeAxis ? grain : null));
  const axisFormat = query.metrics[0] ? metricFormat(query.metrics[0], dataset) : null;
  const categoryAxis = { type: "category" as const, data: labels, axisTick: { alignWithLabel: true } };
  const horizontal = vizType === "bar" && Boolean(display.horizontal);
  // Say what is measured: with one metric the value axis is titled with its label (several
  // metrics are told apart by the legend instead).
  const axisTitle = query.metrics.length === 1 ? metricLabel(query.metrics[0]!, dataset) : undefined;
  const valueAxis = {
    type: "value" as const,
    axisLabel: { formatter: (v: number) => formatNumber(v, axisFormat) },
    ...(axisTitle === undefined
      ? {}
      : horizontal
        ? { name: axisTitle, nameLocation: "middle" as const, nameGap: 28 }
        : { name: axisTitle, nameLocation: "end" as const, nameTextStyle: { align: "left" as const } }),
  };

  const series: SeriesOption[] = pivoted.series.map((s) =>
    vizType === "bar"
      ? {
          type: "bar",
          name: s.name,
          data: s.values,
          stack: display.stacked ? "total" : undefined,
          barMaxWidth: BAR_MAX_WIDTH,
          emphasis: { focus: "series" },
        }
      : {
          type: "line",
          name: s.name,
          data: s.values,
          showSymbol: Boolean(display.show_points),
          symbolSize: 6,
          connectNulls: false,
          emphasis: { focus: "series" },
        },
  );

  return {
    grid: {
      ...GRID,
      // Room above the plot for the legend and/or the axis title (or below it, horizontal).
      top: pivoted.series.length > 1 ? 48 : axisTitle && !horizontal ? 36 : 24,
      bottom: axisTitle && horizontal ? 36 : GRID.bottom,
    },
    legend: pivoted.series.length > 1 ? { type: "scroll", top: 0 } : undefined,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: vizType === "bar" ? "shadow" : "line" },
      formatter: tooltipFormatter(pivoted.series, dataset),
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series,
  };
}

/** Small trend line under a big number. */
export function sparklineOption(state: ChartState, trend: ChartDataResult, dataset: Dataset | null): EChartsOption {
  const metric = state.query.metrics[0]!;
  const grain = state.query.time?.grain ?? null;
  const values = trend.rows.map((r) => toNumber(r[1]));
  const labels = trend.rows.map((r) => categoryLabel(r[0], grain));
  return {
    grid: { left: 4, right: 4, top: 6, bottom: 4 },
    xAxis: { type: "category", data: labels, show: false, boundaryGap: false },
    yAxis: { type: "value", show: false, scale: true },
    tooltip: {
      trigger: "axis",
      formatter: tooltipFormatter([{ name: metricLabel(metric, dataset), metric, values }], dataset),
    },
    series: [
      {
        type: "line",
        name: metricLabel(metric, dataset),
        data: values,
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.12 },
      },
    ],
  };
}
