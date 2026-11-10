/** Round 2: Customize options, label layout and incomplete periods in the ECharts options. */
import { describe, expect, it } from "vitest";
import type { BarSeriesOption, LineSeriesOption } from "echarts";
import type { ChartDataResult, Dataset } from "../api.ts";
import { dataKey, previousQuery } from "./load.ts";
import { adaptToViz, chartRequests, defaultQuery, type ChartState } from "./model.ts";
import { cartesianLayout, pieOption, seriesNamesOf, sparklineOption } from "./options.ts";
import { DATASET } from "./testData.ts";

const dataset: Dataset = DATASET;
const COLORS = ["#c1", "#c2", "#c3", "#c4", "#c5", "#c6", "#c7", "#c8", "#c9", "#c10"];

function result(columns: string[], rows: unknown[][], extra: Partial<ChartDataResult> = {}): ChartDataResult {
  return {
    columns: columns.map((name) => ({ name, type: "string", db_type: "text" })),
    rows,
    row_count: rows.length,
    truncated: false,
    duration_ms: 1,
    sql: "SELECT …",
    ...extra,
  };
}

function chart(viz: ChartState["vizType"], query: Partial<ChartState["query"]> = {}, display: ChartState["display"] = {}): ChartState {
  const s = adaptToViz({ vizType: "table", query: defaultQuery(dataset), display: {} }, viz, dataset);
  return { ...s, query: { ...s.query, ...query }, display: { ...s.display, ...display } };
}

const byStatus = chart("bar", { dimensions: ["status"], series: "channel", time: null });
const statusRows = result(
  ["status", "channel", "count"],
  [
    ["completed", "web", 5],
    ["completed", "store", 3],
    ["refunded", "web", 1],
  ],
);

type Tooltip = { formatter: (p: unknown) => string };

describe("Customize options in the chart", () => {
  it("renames series, keeps the original names for the editor, and formats tooltips", () => {
    const state = { ...byStatus, display: { series_labels: { web: "Online" }, formats: { count: { preset: "number" as const, suffix: " orders" } } } };
    const { option, seriesNames } = cartesianLayout(state, statusRows, dataset, { colors: COLORS });
    expect(seriesNames).toEqual(["web", "store"]);
    expect((option.series as BarSeriesOption[]).map((s) => s.name)).toEqual(["Online", "store"]);
    const html = (option.tooltip as Tooltip).formatter([
      { axisValueLabel: "completed", dataIndex: 0, seriesIndex: 0, marker: "", seriesName: "Online", value: 5 },
    ]);
    expect(html).toContain("Online: <b>5 orders</b>");
  });

  it("uses one color for a single series, the palette otherwise", () => {
    const one = chart("bar", { dimensions: ["status"], time: null }, { color: 4 });
    const single = cartesianLayout(one, result(["status", "count"], [["a", 1]]), dataset, { colors: COLORS }).option;
    expect((single.series as BarSeriesOption[])[0]!.itemStyle).toMatchObject({ color: "#c4" });
    const several = cartesianLayout({ ...byStatus, display: { color: 4 } }, statusRows, dataset, { colors: COLORS }).option;
    expect((several.series as BarSeriesOption[]).map((s) => (s.itemStyle as { color: string }).color)).toEqual(["#c1", "#c2"]);
  });

  it("places or hides the legend, toggles value labels and axis titles", () => {
    const at = (legend: ChartState["display"]["legend"]) => cartesianLayout({ ...byStatus, display: { legend } }, statusRows, dataset).option.legend;
    expect(at(undefined)).toMatchObject({ top: 0 });
    expect(at("bottom")).toMatchObject({ bottom: 0 });
    expect(at("right")).toMatchObject({ orient: "vertical", right: 0 });
    expect(at("none")).toBeUndefined();

    const labelled = cartesianLayout({ ...byStatus, display: { value_labels: true } }, statusRows, dataset).option;
    const label = (labelled.series as BarSeriesOption[])[0]!.label as { show: boolean; formatter: (p: { value: unknown }) => string };
    expect(label.show).toBe(true);
    expect(label.formatter({ value: 1234 })).toBe("1,234");

    const one = chart("bar", { dimensions: ["status"], time: null });
    const rows = result(["status", "count"], [["a", 1]]);
    expect(cartesianLayout(one, rows, dataset).option.yAxis).toMatchObject({ name: "Count" });
    expect(cartesianLayout({ ...one, display: { axis_titles: false } }, rows, dataset).option.yAxis).not.toHaveProperty("name");
  });

  it("orders series by size or name", () => {
    const names = (series_sort: ChartState["display"]["series_sort"]) =>
      (cartesianLayout({ ...byStatus, display: { series_sort } }, statusRows, dataset).option.series as BarSeriesOption[]).map((s) => s.name);
    expect(names("default")).toEqual(["web", "store"]);
    expect(names("label")).toEqual(["store", "web"]);
    const rows = result(["status", "channel", "count"], [["a", "small", 1], ["a", "big", 9]]);
    expect((cartesianLayout({ ...byStatus, display: { series_sort: "value" } }, rows, dataset).option.series as BarSeriesOption[]).map((s) => s.name)).toEqual(["big", "small"]);
  });
});

describe("category labels", () => {
  it("keeps every label (rotated, cut with …) instead of hiding them", () => {
    const films = Array.from({ length: 15 }, (_, i) => [`A LONG FILM TITLE NUMBER ${i}`, i]);
    const state = chart("bar", { dimensions: ["status"], time: null });
    const { option, labels } = cartesianLayout(state, result(["status", "count"], films), dataset, { width: 1000 });
    expect((option.xAxis as { axisLabel: object }).axisLabel).toMatchObject({ interval: 0, rotate: 45, overflow: "truncate", ellipsis: "…" });
    expect(labels.suggestHorizontal).toBe(true);
    // The tooltip title is the full label.
    const html = (option.tooltip as Tooltip).formatter([{ dataIndex: 0, seriesIndex: 0, marker: "", seriesName: "Count", value: 14, axisValueLabel: "cut…" }]);
    expect(html.startsWith("A LONG FILM TITLE NUMBER 14")).toBe(true);
  });
});

describe("incomplete periods", () => {
  const months = result(
    ["order_date", "count"],
    [
      ["2026-09-01", 10],
      ["2026-10-01", 12],
      ["2026-11-01", 3],
    ],
  );
  const coverage = { rangeStart: "2026-09-01", rangeEnd: "2026-11-10" };

  it("draws the last line segment dotted, in the same color, with one legend entry", () => {
    const state = chart("line", { time: { column: "order_date", grain: "month", range: { kind: "last_90_days" } } });
    const { option, partial } = cartesianLayout(state, months, dataset, { colors: COLORS, coverage });
    expect([...partial]).toEqual([2]);
    const [solid, dotted] = option.series as LineSeriesOption[];
    expect(solid!.data).toEqual([10, 12, null]);
    expect(dotted!.data).toEqual([null, 12, 3]);
    expect(dotted!.lineStyle).toMatchObject({ type: "dotted", color: "#c1" });
    expect(dotted!.name).toBe(solid!.name);
    const html = (option.tooltip as Tooltip).formatter([
      { axisValueLabel: "Nov 2026", dataIndex: 2, seriesIndex: 1, seriesId: "partial:0", marker: "", seriesName: "Count", value: 3 },
    ]);
    expect(html).toContain("Incomplete period");
  });

  it("draws incomplete bars lighter with a dashed outline", () => {
    const state = chart("bar", { dimensions: [], time: { column: "order_date", grain: "month", range: { kind: "last_90_days" } } });
    const bars = (cartesianLayout(state, months, dataset, { colors: COLORS, coverage }).option.series as BarSeriesOption[])[0]!;
    expect(bars.data![0]).toBe(10);
    expect(bars.data![2]).toMatchObject({ value: 3, itemStyle: { opacity: 0.45, borderType: "dashed", borderColor: "#c1" } });
  });

  it("marks the big number's trend line too", () => {
    const state = chart("big_number", { time: { column: "order_date", grain: "month", range: { kind: "none" } } }, { show_trend: true });
    const option = sparklineOption(state, months, dataset, { coverage: { dataMax: "2026-11-10" } });
    const series = option.series as LineSeriesOption[];
    expect(series).toHaveLength(2);
    expect(series[1]!.lineStyle).toMatchObject({ type: "dotted" });
  });

  it("leaves complete periods solid", () => {
    const state = chart("line", { time: { column: "order_date", grain: "month", range: { kind: "none" } } });
    const { option } = cartesianLayout(state, months, dataset, { coverage: { dataMin: "2026-09-01", dataMax: "2026-11-30" } });
    expect(option.series).toHaveLength(1);
  });
});

describe("what needs a new query", () => {
  it("display options never change the data key; data options and the comparison do", () => {
    const state = chart("bar", { dimensions: ["status"], series: "channel", time: null });
    const key = dataKey(state);
    const look = { stacked: true, horizontal: true, color: 2, legend: "bottom" as const, title: "T", formats: { count: { preset: "compact" as const } } };
    expect(dataKey({ ...state, display: look })).toBe(key);
    expect(dataKey({ ...state, query: { ...state.query, row_limit: 5 } })).not.toBe(key);
    const big = chart("big_number", { time: { column: "order_date", grain: null, range: { kind: "last_30_days" } } });
    expect(dataKey({ ...big, display: { compare_previous: true } })).not.toBe(dataKey(big));
    expect(dataKey({ ...big, display: { font_size: "l", color_above: 3 } })).toBe(dataKey(big));
  });

  it("asks for the period before the main result's range", () => {
    const big = chart("big_number", { time: { column: "order_date", grain: null, range: { kind: "last_30_days" } } }, { compare_previous: true });
    const main = result(["count"], [[5]], { range_start: "2026-10-11", range_end: "2026-11-10" });
    const q = previousQuery(big, chartRequests(big).main, main, "2026-11-10");
    expect(q?.time).toEqual({ column: "order_date", grain: null, range: { kind: "custom", start: "2026-09-10", end: "2026-10-10" } });
    expect(previousQuery({ ...big, display: {} }, chartRequests(big).main, main, "2026-11-10")).toBeNull();
  });
});

describe("pie / donut", () => {
  const withLabels: Dataset = {
    ...dataset,
    columns: dataset.columns.map((c) => (c.name === "channel" ? { ...c, value_labels: { "1": "Lethbridge", "2": "Woodridge" } } : c)),
  };
  const pie = chart("pie", { dimensions: ["channel"], series_limit: 2 });
  const rows = result(
    ["channel", "__other", "count"],
    [
      ["2", 0, 30],
      ["1", 0, 50],
      [null, 1, 20],
    ],
  );

  it("switches to one dimension, one metric, no grain, six top slices", () => {
    const fromBar = adaptToViz(chart("bar", { dimensions: ["status"], metrics: ["count", "revenue"], time: null }), "pie", dataset);
    expect(fromBar.query).toMatchObject({ dimensions: ["status"], metrics: ["count"], series: null, series_limit: 6 });
    const fromLine = adaptToViz(chart("line", { series: "channel" }), "pie", dataset);
    expect(fromLine.query).toMatchObject({ dimensions: ["channel"], series: null });
    expect(fromLine.query.time?.grain).toBeNull();
  });

  it("labels slices with value labels and renames, biggest first, Other last", () => {
    const state = { ...pie, display: { series_labels: { Lethbridge: "LB" } } };
    const option = pieOption(state, rows, withLabels, { colors: COLORS });
    const data = (option.series as { data: { name: string; value: number; itemStyle: { color: string } }[] }[])[0]!.data;
    expect(data.map((d) => [d.name, d.value])).toEqual([["LB", 50], ["Woodridge", 30], ["Other", 20]]);
    expect(data.map((d) => d.itemStyle.color)).toEqual(["#c1", "#c2", "#c9"]);
    expect(seriesNamesOf(state, rows, withLabels)).toEqual(["Lethbridge", "Woodridge", "Other"]);
    const byName = pieOption({ ...pie, display: { sort: "label" } }, rows, withLabels);
    expect((byName.series as { data: { name: string }[] }[])[0]!.data.map((d) => d.name)).toEqual(["Lethbridge", "Woodridge", "Other"]);
  });

  it("puts the true total in the middle of a donut (one more query)", () => {
    const donut = { ...pie, display: { donut: true, formats: { count: { preset: "number" as const, suffix: " rentals" } } } };
    const total = result(["count"], [[100]]);
    const option = pieOption(donut, rows, withLabels, { total });
    expect(option.title).toMatchObject({ text: "100 rentals", subtext: "Count", textAlign: "center" });
    expect((option.series as { radius: unknown }[])[0]!.radius).toEqual(["52%", "78%"]);
    const requests = chartRequests(donut);
    expect(requests.total).toMatchObject({ dimensions: [], series_limit: null });
    expect(chartRequests(pie).total).toBeNull();
    expect(dataKey(donut)).not.toBe(dataKey(pie));
    expect(dataKey({ ...pie, display: { sort: "label", legend: "bottom" } })).toBe(dataKey(pie));
  });

  it("shows percentages in tooltips and labels", () => {
    const option = pieOption({ ...pie, display: { value_labels: true } }, rows, withLabels);
    const tooltip = (option.tooltip as Tooltip).formatter({ name: "Woodridge", value: 30, percent: 30, marker: "" });
    expect(tooltip).toBe("Woodridge: <b>30</b> (30.0%)");
    const label = (option.series as { label: { formatter(p: unknown): string } }[])[0]!.label;
    expect(label.formatter({ name: "Woodridge", value: 30, percent: 30 })).toBe("Woodridge\n30 · 30%");
  });
});

describe("value labels", () => {
  const withLabels: Dataset = {
    ...dataset,
    columns: dataset.columns.map((c) =>
      c.name === "status" ? { ...c, value_labels: { completed: "Done" } } : c.name === "channel" ? { ...c, value_labels: { web: "Online" } } : c,
    ),
  };

  it("are used on the category axis and in legends", () => {
    const { option, seriesNames } = cartesianLayout(byStatus, statusRows, withLabels);
    expect((option.xAxis as { data: string[] }).data).toEqual(["Done", "refunded"]);
    expect((option.series as BarSeriesOption[]).map((s) => s.name)).toEqual(["Online", "store"]);
    expect(seriesNames).toEqual(["Online", "store"]);
  });
});
