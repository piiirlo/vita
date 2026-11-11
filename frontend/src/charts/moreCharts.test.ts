/** Part 11: chart type switching, area / combo options, treemap, funnel, gauge and pivot logic. */
import { describe, expect, it } from "vitest";
import type { LineSeriesOption } from "echarts";
import type { ChartDataResult, Dataset } from "../api.ts";
import {
  adaptToViz,
  chartRequests,
  defaultQuery,
  missingFor,
  PIVOT_MAX_COLUMNS,
  PIVOT_ROW_LIMIT,
  switchReport,
  type ChartState,
} from "./model.ts";
import { searchViz, VIZ_INFO } from "./vizGallery.ts";
import { funnelSteps, gaugeOption, gaugeScale, gaugeTone, niceCeil, nonAdditive, treemapOption, treemapTree } from "./moreCharts.ts";
import { cartesianLayout, comboSeries, shares } from "./options.ts";
import { heatLevel, pivotLayout, pathKey } from "./pivotTable.ts";
import { DATASET } from "./testData.ts";

const dataset: Dataset = {
  ...DATASET,
  columns: DATASET.columns.map((c) => (c.name === "channel" ? { ...c, value_labels: { web: "Website" } } : c)),
};
const COLORS = ["#c1", "#c2", "#c3", "#c4", "#c5", "#c6", "#c7", "#c8", "#c9", "#c10"];
const TOKENS = { text: "#text", muted: "#muted", border: "#track", band: "#band", danger: "#red", warning: "#amber", success: "#green", accent: "#orange", surface: "#card" };

function result(columns: string[], rows: unknown[][], extra: Partial<ChartDataResult> = {}): ChartDataResult {
  return {
    columns: columns.map((name) => ({ name, type: "string", db_type: "text" })),
    rows,
    row_count: rows.length,
    truncated: false,
    duration_ms: 1,
    sql: "",
    ...extra,
  };
}

const base = (): ChartState => adaptToViz({ vizType: "table", query: defaultQuery(dataset), display: {} }, "table", dataset);
function chart(viz: ChartState["vizType"], query: Partial<ChartState["query"]> = {}, display: ChartState["display"] = {}): ChartState {
  const s = adaptToViz(base(), viz, dataset);
  return { ...s, query: { ...s.query, ...query }, display: { ...s.display, ...display } };
}

describe("chart type gallery and switching", () => {
  it("lists 11 types in groups and searches labels, groups and keywords", () => {
    expect(VIZ_INFO.map((v) => v.value)).toHaveLength(11);
    expect(searchViz("donut").map((v) => v.value)).toEqual(["pie"]);
    expect(searchViz("KPI").map((v) => v.value)).toEqual(["big_number", "gauge"]);
    expect(searchViz("totals").map((v) => v.value)).toEqual(["pivot_table"]);
    expect(searchViz("part of whole").map((v) => v.value)).toEqual(["pie", "treemap", "funnel"]);
    expect(searchViz("  ")).toHaveLength(11);
  });

  it("keeps compatible settings and says what didn't carry over", () => {
    const line: ChartState = {
      vizType: "line",
      query: {
        ...defaultQuery(dataset),
        metrics: ["count", "revenue"],
        series: "channel",
        filters: [{ column: "status", operator: "=", value: "paid" }],
        time: { column: "order_date", grain: "month", range: { kind: "last_90_days" } },
      },
      display: {},
    };
    const funnel = adaptToViz(line, "funnel", dataset);
    expect(funnel.query).toMatchObject({ metrics: ["count"], dimensions: ["channel"], series: null, time: { grain: null, range: { kind: "last_90_days" } } });
    const report = switchReport(line, funnel, dataset);
    expect(report.kept).toEqual(["dataset", "Count", "1 filter", "last 90 days"]);
    expect(report.dropped).toEqual(["Revenue (a funnel uses one metric)", "time grain (a funnel has none; the time range still filters)"]);
    expect(report.todo).toEqual([]);

    // Area keeps everything from a line; combo drops the series and asks for nothing more.
    expect(switchReport(line, adaptToViz(line, "area", dataset), dataset).dropped).toEqual([]);
    const combo = adaptToViz(line, "combo", dataset);
    expect(combo.query.series).toBeNull();
    expect(switchReport(line, combo, dataset).dropped).toEqual(["Channel (not used by a combo)"]);
  });

  it("says what still needs setting", () => {
    expect(missingFor(chart("funnel", { dimensions: [] }), dataset)).toEqual(["Pick the steps (a dimension)"]);
    expect(missingFor(chart("treemap", { dimensions: [] }), dataset)).toEqual(["Pick the boxes (a dimension)"]);
    expect(missingFor(chart("pivot_table", { dimensions: [], column_dimensions: [] }), dataset)).toEqual(["Add a row or column dimension"]);
    expect(missingFor(chart("combo", { metrics: ["count"] }), dataset)).toEqual(["Add a second metric to show bars and lines together"]);
    expect(missingFor(chart("gauge"), dataset)).toEqual([]);
  });

  it("pivot: rows from dimensions and the series, totals on, big row limit; leaving it cleans up", () => {
    const bar = chart("bar", { dimensions: ["status"], series: "channel", time: null });
    const pivot = adaptToViz(bar, "pivot_table", dataset);
    expect(pivot.query).toMatchObject({ dimensions: ["status", "channel"], column_dimensions: [], totals: true, row_limit: PIVOT_ROW_LIMIT, series: null });
    const withColumns = { ...pivot, query: { ...pivot.query, dimensions: ["status"], column_dimensions: ["channel"] } };
    // A table keeps the column dimensions as dimensions; a bar chart drops them.
    expect(adaptToViz(withColumns, "table", dataset).query).toMatchObject({ dimensions: ["status", "channel"] });
    const backToBar = adaptToViz(withColumns, "bar", dataset).query;
    expect(backToBar.column_dimensions).toBeUndefined();
    expect(backToBar.totals).toBeUndefined();
    expect(backToBar.row_limit).toBe(1000);
  });

  it("requests: treemap asks each outer box's own value; others never send pivot fields", () => {
    const treemap = chart("treemap", { dimensions: ["status", "channel"] });
    const r = chartRequests(treemap);
    expect(r.total).toMatchObject({ dimensions: ["status"], series_limit: treemap.query.series_limit });
    expect(r.totalViz).toBe("treemap");
    expect(chartRequests(chart("treemap", { dimensions: ["status"] })).total).toBeNull();
    const gauge = chartRequests(chart("gauge", { time: { column: "order_date", grain: "month", range: { kind: "none" } } }));
    expect(gauge.main.time?.grain).toBeNull();
    const bar = chartRequests({ ...chart("bar"), query: { ...chart("bar").query, column_dimensions: ["x"], totals: true } });
    expect(bar.main).not.toHaveProperty("column_dimensions");
    expect(bar.main).not.toHaveProperty("totals");
  });
});

describe("area and combo", () => {
  const rows = result(
    ["order_date", "channel", "count"],
    [
      ["2025-01-01", "web", 30],
      ["2025-01-01", "store", 10],
      ["2025-02-01", "web", 0],
      ["2025-02-01", "store", 0],
    ],
  );
  const area = chart("area", { series: "channel", time: { column: "order_date", grain: "month", range: { kind: "none" } } });

  it("100% stacked: shares per period, the real value in the tooltip", () => {
    expect(shares([[30, 0], [10, 0]])).toEqual([[75, 0], [25, 0]]);
    const { option } = cartesianLayout({ ...area, display: { stack: "percent" } }, rows, dataset, { colors: COLORS });
    const series = option.series as LineSeriesOption[];
    expect(series.map((s) => s.stack)).toEqual(["total", "total"]);
    expect((series[0]!.data as { value: number; raw: number }[])[0]).toEqual({ value: 75, raw: 30 });
    expect((option.yAxis as { max: number }).max).toBe(100);
    expect(series.every((s) => s.areaStyle)).toBe(true);
    const tooltip = (option.tooltip as { formatter: (p: unknown) => string }).formatter([
      { dataIndex: 0, seriesIndex: 0, marker: "", seriesName: "Website", value: 75, data: { value: 75, raw: 30 }, axisValueLabel: "Jan 2025" },
    ]);
    expect(tooltip).toContain("75.0%");
    expect(tooltip).toContain("(30)");
  });

  it("not stacked by default; incomplete periods are a shaded band", () => {
    const { option, partial } = cartesianLayout(area, rows, dataset, {
      colors: COLORS,
      tokens: TOKENS,
      coverage: { rangeStart: null, rangeEnd: null, dataMin: "2025-01-01", dataMax: "2025-02-10" },
    });
    const series = option.series as LineSeriesOption[];
    expect(series.map((s) => s.stack)).toEqual([undefined, undefined]);
    expect(partial).toEqual(new Set([1]));
    expect(series[0]!.markArea).toMatchObject({ itemStyle: { color: "#band", borderType: "dashed" }, data: [[{ xAxis: "Jan 2025" }, { xAxis: "Feb 2025" }]] });
    expect(series).toHaveLength(2); // no dotted twins: they couldn't stack
  });

  it("combo: bars or line per metric, a second axis when one is on the right", () => {
    const combo = chart("combo", { metrics: ["count", "revenue"], dimensions: ["status"], time: null });
    expect(comboSeries({}, "count", 0)).toEqual({ type: "bar", axis: "left" });
    expect(comboSeries({}, "revenue", 1)).toEqual({ type: "line", axis: "left" });
    const data = result(["status", "count", "revenue"], [["paid", 3, 1200.5], ["open", 5, 99]]);
    const one = cartesianLayout(combo, data, dataset, { colors: COLORS }).option;
    expect((one.series as { type: string }[]).map((s) => s.type)).toEqual(["bar", "line"]);
    expect(Array.isArray(one.yAxis)).toBe(false);
    const two = cartesianLayout({ ...combo, display: { combo: { revenue: { type: "line", axis: "right" } } } }, data, dataset, { colors: COLORS }).option;
    const axes = two.yAxis as { name?: string; position?: string; axisLabel: { formatter: (v: number) => string } }[];
    expect(axes).toHaveLength(2);
    expect(axes.map((a) => a.name)).toEqual(["Count", "Revenue"]);
    expect(axes[1]!.position).toBe("right");
    expect(axes[1]!.axisLabel.formatter(1200)).toBe("$1,200.00"); // the right axis has its metric's format
    expect((two.series as { yAxisIndex?: number }[]).map((s) => s.yAxisIndex)).toEqual([0, 1]);
    // Bars sorted by value like a bar chart.
    expect(((two.xAxis as { data: string[] }).data)).toEqual(["open", "paid"]);
  });
});

describe("treemap", () => {
  const two = chart("treemap", { dimensions: ["status", "channel"], metrics: ["revenue"] });
  const rows = result(
    ["status", "channel", "__other", "revenue"],
    [
      ["paid", "web", 0, 50],
      ["paid", "store", 0, 30],
      ["open", "web", 0, 15],
      [null, null, 1, 5],
    ],
  );

  it("groups children under their outer box, Other last, own values from the second query", () => {
    const total = result(["status", "__other", "revenue"], [["paid", 0, 80], ["open", 0, 15], [null, 1, 5]]);
    const tree = treemapTree(two, rows, dataset, total);
    expect(tree.map((n) => [n.name, n.value, n.ownValue, n.other])).toEqual([
      ["paid", 80, 80, false],
      ["open", 15, 15, false],
      ["Other", 5, 5, true],
    ]);
    expect(tree[0]!.children!.map((c) => c.name)).toEqual(["Website", "store"]); // value labels
    const option = treemapOption({ ...two, display: { series_labels: { paid: "Paid" } } }, rows, dataset, { colors: COLORS, total });
    const data = (option.series as { data: { name: string; itemStyle?: { color: string } }[] }[])[0]!.data;
    expect(data.map((d) => d.name)).toEqual(["Paid", "open", "Other"]);
    expect(data.map((d) => d.itemStyle?.color)).toEqual(["#c1", "#c2", "#c9"]);
  });

  it("tooltips of outer boxes show their real value (an average isn't the sum of its parts)", () => {
    const total = result(["status", "__other", "revenue"], [["paid", 0, 42]]);
    const option = treemapOption(two, rows, dataset, { total });
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter;
    expect(formatter({ name: "paid", value: 80, treePathInfo: [{ name: "" }, { name: "paid" }], data: { ownValue: 42, children: [{}] } })).toBe("paid: <b>$42.00</b>");
    expect(formatter({ name: "web", value: 50, treePathInfo: [{ name: "" }, { name: "paid" }, { name: "web" }], data: {} })).toBe("paid › web: <b>$50.00</b>");
  });

  it("knows which metrics don't add up", () => {
    expect(nonAdditive(two, dataset)).toBe(false); // SUM
    expect(nonAdditive({ ...two, query: { ...two.query, metrics: [{ column: "line_total", aggregate: "AVG" }] } }, dataset)).toBe(true);
    expect(nonAdditive({ ...two, query: { ...two.query, metrics: [{ column: "line_total", aggregate: "COUNT" }] } }, dataset)).toBe(false);
  });
});

describe("funnel", () => {
  const funnel = chart("funnel", { dimensions: ["status"] });
  const rows = result(["status", "count"], [["visit", 1000], ["cart", 250], ["signup", 400], ["paid", 100]]);

  it("largest first, with % of the first and of the previous step", () => {
    const steps = funnelSteps(funnel, rows, dataset);
    expect(steps.map((s) => s.name)).toEqual(["visit", "signup", "cart", "paid"]);
    expect(steps.map((s) => s.ofFirst)).toEqual([null, 0.4, 0.25, 0.1]);
    expect(steps.map((s) => s.ofPrevious)).toEqual([null, 0.4, 0.625, 0.4]);
  });

  it("follows a chosen order; steps not listed follow by value", () => {
    const custom = { ...funnel, display: { funnel_order: "custom" as const, funnel_steps: ["visit", "cart", "paid"] } };
    expect(funnelSteps(custom, rows, dataset).map((s) => s.name)).toEqual(["visit", "cart", "paid", "signup"]);
    expect(funnelSteps(custom, rows, dataset)[1]!.ofPrevious).toBe(0.25);
  });
});

describe("gauge", () => {
  it("picks a round max above the value and target, sorts and clips bands", () => {
    expect([niceCeil(0), niceCeil(7), niceCeil(11), niceCeil(230), niceCeil(2600)]).toEqual([1, 10, 20, 250, 5000]);
    expect(gaugeScale(75, {})).toEqual({ min: 0, max: 100, target: null, bands: [] });
    const scale = gaugeScale(42, {
      gauge_max: 100,
      gauge_target: 80,
      gauge_bands: [
        { to: 120, tone: "success" },
        { to: 30, tone: "danger" },
        { to: 70, tone: "warning" },
      ],
    });
    expect(scale.bands).toEqual([
      { from: 0, to: 30, tone: "danger" },
      { from: 30, to: 70, tone: "warning" },
      { from: 70, to: 100, tone: "success" },
    ]);
    expect(gaugeTone(42, scale)).toBe("warning");
  });

  it("draws bands as color stops with a needle, else an orange progress arc, and a target marker", () => {
    const gauge = chart("gauge");
    const data = result(["count"], [[42]]);
    const banded = gaugeOption({ ...gauge, display: { gauge_max: 100, gauge_target: 80, gauge_bands: [{ to: 30, tone: "danger" }, { to: 70, tone: "warning" }] } }, data, dataset, {
      tokens: TOKENS,
    });
    const [main, target] = banded.series as { axisLine: { lineStyle: { color: unknown } }; pointer: { show: boolean }; data: { value: number }[] }[];
    expect(main!.axisLine.lineStyle.color).toEqual([
      [0.3, "#red"],
      [0.7, "#amber"],
      [1, "#track"],
    ]);
    expect(main!.pointer.show).toBe(true);
    expect(target!.data[0]!.value).toBe(80);
    const plain = gaugeOption(gauge, data, dataset, { tokens: TOKENS }).series as { progress: { show: boolean; itemStyle?: { color: string } } }[];
    expect(plain).toHaveLength(1);
    expect(plain[0]!.progress).toMatchObject({ show: true, itemStyle: { color: "#orange" } });
  });
});

describe("pivot table layout", () => {
  // status (rows) x channel (columns), count; every level from SQL (__row_level / __col_level).
  const cols = ["status", "channel", "__row_level", "__col_level", "count", "revenue"];
  const rows = result(cols, [
    ["open", "store", 1, 1, 2, 10],
    ["open", "web", 1, 1, 3, 20],
    ["open", null, 1, 0, 5, 30],
    ["paid", "web", 1, 1, 7, 70],
    ["paid", null, 1, 0, 7, 70],
    [null, "web", 1, 1, 1, 1], // a real NULL status, not a total
    [null, null, 1, 0, 1, 1],
    [null, "store", 0, 1, 2, 10],
    [null, "web", 0, 1, 11, 91],
    [null, null, 0, 0, 13, 101],
  ]);
  const spec = { rows: ["status"], cols: ["channel"], metrics: ["count"], totals: true, display: {}, dataset };

  it("lays out cells, row and column totals from SQL, and keeps NULL apart from totals", () => {
    const layout = pivotLayout(rows, spec);
    expect(layout.header[0]!.map((h) => h.label)).toEqual(["Status", "store", "Website", "Total"]);
    expect(layout.body.map((r) => [r.label, r.kind, ...r.cells.map((c) => c.text)])).toEqual([
      ["open", "leaf", "2", "3", "5"],
      ["paid", "leaf", "", "7", "7"],
      ["(empty)", "leaf", "", "1", "1"],
      ["Total", "total", "2", "11", "13"],
    ]);
  });

  it("several metrics get a header row of their own; heat only on leaf cells", () => {
    const layout = pivotLayout(rows, { ...spec, metrics: ["count", "revenue"], display: { heat: ["revenue"] } });
    expect(layout.header).toHaveLength(2);
    expect(layout.header[1]!.map((h) => h.label)).toEqual(["Count", "Revenue", "Count", "Revenue", "Count", "Revenue"]);
    const open = layout.body[0]!;
    expect(open.cells.map((c) => c.heat)).toEqual([null, 1, null, 2, null, null]); // revenue 10 / 20 of 1..70; totals plain
    expect(layout.body.at(-1)!.cells.every((c) => c.heat === null)).toBe(true);
    expect([heatLevel(70, 1, 70), heatLevel(1, 1, 70), heatLevel(5, 5, 5), heatLevel(null, 0, 1)]).toEqual([5, 1, null, null]);
  });

  it("collapses row groups to their subtotal (two row dimensions)", () => {
    const nested = result(["status", "channel", "__row_level", "__col_level", "count"], [
      ["open", "store", 2, 0, 2],
      ["open", "web", 2, 0, 3],
      ["open", null, 1, 0, 5],
      ["paid", "web", 2, 0, 7],
      ["paid", null, 1, 0, 7],
      [null, null, 0, 0, 12],
    ]);
    const s = { rows: ["status", "channel"], cols: [], metrics: ["count"], totals: true, display: {}, dataset };
    const open = pivotLayout(nested, s);
    expect(open.body.map((r) => [r.label, r.kind, r.depth, r.cells[0]!.text])).toEqual([
      ["open", "group", 0, "5"],
      ["store", "leaf", 1, "2"],
      ["Website", "leaf", 1, "3"],
      ["paid", "group", 0, "7"],
      ["Website", "leaf", 1, "7"],
      ["Total", "total", 0, "12"],
    ]);
    const closed = pivotLayout(nested, { ...s, collapsedRows: new Set([pathKey(["open"])]) });
    expect(closed.body.map((r) => r.label)).toEqual(["open", "paid", "Website", "Total"]);
    expect(closed.body[0]!.collapsed).toBe(true);
  });

  it("two column dimensions: subtotal per outer group, which collapses", () => {
    const wide = result(["status", "channel", "order_date", "__row_level", "__col_level", "count"], [
      ["open", "store", "2025-01-01", 1, 2, 1],
      ["open", "store", "2025-02-01", 1, 2, 1],
      ["open", "store", null, 1, 1, 2],
      ["open", "web", "2025-01-01", 1, 2, 3],
      ["open", "web", null, 1, 1, 3],
      ["open", null, null, 1, 0, 5],
    ]);
    const s = { rows: ["status"], cols: ["channel", "order_date"], metrics: ["count"], totals: true, display: {}, dataset };
    const layout = pivotLayout(wide, s);
    expect(layout.header[0]!.map((h) => [h.label, h.colSpan])).toEqual([["Status", 1], ["store", 3], ["Website", 2], ["Total", 1]]);
    expect(layout.header[1]!.map((h) => h.label)).toEqual(["2025-01-01", "2025-02-01", "Total", "2025-01-01", "Total"]);
    expect(layout.body[0]!.cells.map((c) => c.text)).toEqual(["1", "1", "2", "3", "3", "5"]);
    const collapsed = pivotLayout(wide, { ...s, collapsedCols: new Set([pathKey(["store"])]) });
    expect(collapsed.header[0]![1]).toMatchObject({ label: "store", colSpan: 1, collapsed: true });
    expect(collapsed.body[0]!.cells.map((c) => c.text)).toEqual(["2", "3", "3", "5"]);
  });

  it(`caps the columns at ${PIVOT_MAX_COLUMNS} and says how many there were`, () => {
    const many = result(
      ["status", "channel", "__row_level", "__col_level", "count"],
      Array.from({ length: 60 }, (_, i) => ["open", `c${String(i).padStart(2, "0")}`, 1, 1, i]),
    );
    const layout = pivotLayout(many, { ...spec, totals: false });
    expect(layout.totalColumns).toBe(60);
    expect(layout.hiddenColumns).toBe(10);
    expect(layout.body[0]!.cells).toHaveLength(PIVOT_MAX_COLUMNS);
  });
});
