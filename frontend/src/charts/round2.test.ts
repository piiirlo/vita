/** Part 11 round 2: date buckets / time parts, heatmap, scatter, histogram, country matching. */
import { describe, expect, it } from "vitest";
import type { ChartDataResult, Dataset } from "../api.ts";
import { dimensionOptions, partValueLabel, splitDim } from "./dimensions.ts";
import { binLabel, heatmapAxis, heatmapOption, histogramBins, histogramOption, scaleColors, scatterOption, scatterPoints, SCATTER_MAX_COLORS } from "./distribution.ts";
import { matchCountry, matchRows, normalizeCountry } from "./geo/countryMatch.ts";
import { unmatchedNotice, worldMapOption, worldMatch } from "./geo/worldMap.ts";
import { adaptToViz, chartRequests, columnLabel, defaultQuery, dimensionLabel, missingFor, SCATTER_MAX_POINTS, switchReport, type ChartState } from "./model.ts";
import { pivotLayout } from "./pivotTable.ts";
import { DATASET } from "./testData.ts";

const dataset: Dataset = {
  ...DATASET,
  columns: [
    ...DATASET.columns,
    { ...DATASET.columns[0]!, id: 50, name: "created_at", label: "Created", raw_type: "timestamp", generic_type: "datetime", effective_type: "datetime" },
    { ...DATASET.columns[1]!, id: 51, name: "country", label: "Country", value_labels: { Yugoslavia: "Serbia" } },
  ],
};
const COLORS = ["#c1", "#c2", "#c3", "#c4", "#c5", "#c6", "#c7", "#c8", "#c9", "#c10"];
const TOKENS = { text: "#111111", surface: "#ffffff", tint: "#eeeeee", border: "#cccccc", accent: "#ff5a22" };

function result(columns: string[], rows: unknown[][], extra: Partial<ChartDataResult> = {}): ChartDataResult {
  return { columns: columns.map((name) => ({ name, type: "string", db_type: "text" })), rows, row_count: rows.length, truncated: false, duration_ms: 1, sql: "", ...extra };
}
const base = (): ChartState => adaptToViz({ vizType: "table", query: defaultQuery(dataset), display: {} }, "table", dataset);
function chart(viz: ChartState["vizType"], query: Partial<ChartState["query"]> = {}, display: ChartState["display"] = {}): ChartState {
  const s = adaptToViz(base(), viz, dataset);
  return { ...s, query: { ...s.query, ...query }, display: { ...s.display, ...display } };
}

describe("date buckets and time parts", () => {
  it("reads 'column@part' refs, and labels them", () => {
    expect(splitDim("order_date@month", dataset)).toEqual({ column: "order_date", part: "month" });
    expect(splitDim("created_at@day_of_week", dataset)).toEqual({ column: "created_at", part: "day_of_week" });
    expect(splitDim("status", dataset)).toEqual({ column: "status", part: null });
    expect(splitDim("weird@name", { ...dataset, columns: [...dataset.columns, { ...dataset.columns[1]!, name: "weird@name" }] })).toEqual({ column: "weird@name", part: null });
    expect(columnLabel("created_at@hour_of_day", dataset)).toBe("Created · hour of day");
    expect(columnLabel("order_date@quarter", dataset)).toBe("order_date · by quarter");
  });

  it("shows weekdays Monday first, hours, months and buckets", () => {
    expect([1, 2, 7].map((d) => partValueLabel(d, "day_of_week"))).toEqual(["Mon", "Tue", "Sun"]);
    expect(partValueLabel(8, "hour_of_day")).toBe("08:00");
    expect(partValueLabel("12", "month_of_year")).toBe("Dec");
    expect(dimensionLabel("2026-03-01", "order_date@month", dataset)).toBe("Mar 2026");
    expect(dimensionLabel(null, "order_date@month", dataset)).toBe("(empty)");
  });

  it("offers buckets and parts of time columns (no hour for plain dates)", () => {
    const options = dimensionOptions(dataset.columns, { buckets: ["month"], parts: ["day_of_week", "hour_of_day"], raw: false }).map((o) => o.value);
    expect(options).toContain("order_date@month");
    expect(options).toContain("created_at@hour_of_day");
    expect(options).not.toContain("order_date@hour_of_day");
    expect(options).not.toContain("order_date");
    expect(options).toContain("status");
  });
});

describe("switching to the round 2 types", () => {
  it("heatmap defaults to weekday x hour with a datetime column; scatter keeps every color; histogram bins a number", () => {
    expect(chart("heatmap").query.dimensions).toEqual(["created_at@day_of_week", "created_at@hour_of_day"]);
    const scatter = chart("scatter", { metrics: ["revenue"] });
    expect(adaptToViz({ ...base(), query: { ...base().query, metrics: ["revenue"] } }, "scatter", dataset).query).toMatchObject({
      metrics: ["revenue", "count"],
      dimensions: ["status"],
      series_limit: null,
      row_limit: SCATTER_MAX_POINTS,
    });
    expect(chartRequests({ ...scatter, query: { ...scatter.query, series: "channel", series_limit: 5 } }).main.series_limit).toBeNull();
    const histogram = chart("histogram");
    expect(histogram.query).toMatchObject({ bins: { column: "line_total", count: 20 }, metrics: ["count"], dimensions: [] });
    expect(adaptToViz(histogram, "bar", dataset).query.bins).toBeUndefined();
    expect(switchReport(histogram, adaptToViz(histogram, "bar", dataset), dataset).dropped).toContain("the bins of line_total (only histograms bin)");
    expect(chart("world_map").query.dimensions).toEqual(["country"]); // a column that looks like countries
  });

  it("says what still needs setting", () => {
    expect(missingFor(chart("heatmap", { dimensions: ["status"] }), dataset)).toEqual(["Pick the heatmap's rows and columns (two dimensions)"]);
    expect(missingFor(chart("scatter", { metrics: ["count"], dimensions: [] }), dataset)).toEqual(["Pick a metric for the y axis", "Pick what each point is (a dimension)"]);
    expect(missingFor(chart("histogram", { bins: null }), dataset)).toEqual(["Pick a number column to bin"]);
  });
});

describe("heatmap", () => {
  const state = chart("heatmap", { dimensions: ["created_at@day_of_week", "created_at@hour_of_day"] });
  const rows = result(["created_at@day_of_week", "created_at@hour_of_day", "count"], [
    [1, 8, 2],
    [7, 23, 5],
  ]);

  it("shows every weekday (Monday first) and hour; cells without rows stay empty", () => {
    const days = heatmapAxis(rows, "created_at@day_of_week", dataset, null);
    expect(days.labels).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(heatmapAxis(rows, "created_at@hour_of_day", dataset, null).labels).toHaveLength(24);
    const { option } = heatmapOption(state, rows, dataset, { colors: ["#f0541c", "#6e7d2e", "#3e4b1d"], tokens: TOKENS });
    const series = (option.series as { data: unknown[] }[])[0]!;
    expect(series.data).toEqual([
      [8, 0, 2],
      [23, 6, 5],
    ]);
    expect(option.visualMap).toMatchObject({ min: 2, max: 5, inRange: { color: ["#eeeeee", "#6e7d2e", "#3e4b1d"] } });
  });

  it("puts an axis of dates in order even when rows are sorted by the other dimension", () => {
    // Rows come sorted by status: "open" only has March, "paid" adds January later.
    const data = result(["status", "order_date@month", "count"], [
      ["open", "2026-03-01", 1],
      ["paid", "2026-01-01", 2],
      ["paid", "2026-03-01", 3],
    ]);
    expect(heatmapAxis(data, "order_date@month", dataset, null).labels).toEqual(["Jan 2026", "Mar 2026"]);
    expect(heatmapAxis(data, "status", dataset, null).labels).toEqual(["open", "paid"]);
  });

  it("dashes the cells of incomplete date buckets", () => {
    const monthly = chart("heatmap", { dimensions: ["status", "order_date@month"] });
    const data = result(["status", "order_date@month", "count"], [
      ["paid", "2026-01-01", 1],
      ["paid", "2026-02-01", 2],
      ["paid", "2026-03-01", 3],
    ]);
    const { option, partial } = heatmapOption(monthly, data, dataset, {
      tokens: TOKENS,
      coverageFor: (ref) => (ref === "order_date@month" ? { dataMin: "2026-01-01", dataMax: "2026-03-10" } : null),
    });
    expect(partial).toBe(true);
    const cells = (option.series as { data: unknown[] }[])[0]!.data;
    expect(cells[2]).toMatchObject({ value: [2, 0, 3], incomplete: true, itemStyle: { borderType: "dashed" } });
    expect(cells[0]).toEqual([0, 0, 1]);
  });

  it("orders the color scale by contrast with the card", () => {
    // Light theme: olive, then dark olive (more contrast) for the highest values.
    expect(scaleColors({ colors: ["#f0541c", "#6e7d2e", "#3e4b1d"], tokens: { tint: "#eaeee9", surface: "#ffffff" } })).toEqual(["#eaeee9", "#6e7d2e", "#3e4b1d"]);
    // Dark theme: the bright olive stands out more on the dark card.
    expect(scaleColors({ colors: ["#ff5a22", "#b5c566", "#6f8235"], tokens: { tint: "#0b0d07", surface: "#171c0f" } })).toEqual(["#0b0d07", "#6f8235", "#b5c566"]);
  });
});

describe("scatter / bubble", () => {
  it("one point per value, colored by the series, sized by area", () => {
    const state = chart("scatter", { metrics: ["revenue", "count", { column: "line_total", aggregate: "MAX", label: "biggest" }], dimensions: ["status"], series: "channel" });
    const rows = result(["status", "channel", "revenue", "count", "biggest"], [
      ["paid", "web", 100, 3, 10],
      ["open", "store", 50, 1, 40],
      ["lost", "web", 10, null, 5],
    ]);
    const { points, groups } = scatterPoints(state, rows, dataset);
    expect(points.map((p) => [p.name, p.x, p.y, p.size, p.group])).toEqual([
      ["paid", 100, 3, 10, "web"],
      ["open", 50, 1, 40, "store"],
    ]); // no y: no point
    expect(groups).toEqual(["web", "store"]);
    const option = scatterOption(state, rows, dataset, { colors: COLORS });
    const series = option.series as { name: string; data: { symbolSize: number }[] }[];
    expect(series.map((s) => s.name)).toEqual(["web", "store"]);
    expect(series[0]!.data[0]!.symbolSize).toBe(6);
    expect(series[1]!.data[0]!.symbolSize).toBe(34);
    expect((option.xAxis as { name: string }).name).toBe("Revenue");
  });

  it(`keeps ${SCATTER_MAX_COLORS} colors and groups the rest as Other`, () => {
    const state = chart("scatter", { metrics: ["revenue", "count"], dimensions: ["status"], series: "channel" });
    const rows = result(["status", "channel", "revenue", "count"], Array.from({ length: 12 }, (_, i) => [`s${i}`, `c${i}`, i, i]));
    const { groups } = scatterPoints(state, rows, dataset);
    expect(groups).toHaveLength(SCATTER_MAX_COLORS + 1);
    expect(groups.at(-1)).toBe("Other");
  });
});

describe("histogram", () => {
  it("fills empty bins with 0, keeps NULLs apart, labels ranges", () => {
    const state = chart("histogram", { bins: { column: "line_total", count: 4 } });
    const rows = result(["__bin", "__bin_start", "__bin_end", "count"], [
      [null, null, null, 2],
      [0, -3.5, -2, 1],
      [3, 1, 2.5, 4],
    ]);
    const { bins, missing } = histogramBins(state, rows);
    expect(missing).toBe(2);
    expect(bins.map((b) => [b.index, b.start, b.end, b.value])).toEqual([
      [0, -3.5, -2, 1],
      [1, -2, -0.5, 0],
      [2, -0.5, 1, 0],
      [3, 1, 2.5, 4],
    ]);
    expect(bins.map(binLabel)).toEqual(["-3.5 – -2", "-2 – -0.5", "-0.5 – 1", "1 – 2.5"]);
    const option = histogramOption(state, rows, dataset, { colors: COLORS });
    expect((option.series as { data: number[] }[])[0]!.data).toEqual([1, 0, 0, 4]);
    expect((option.xAxis as { name: string }).name).toBe("line_total");
  });

  it("a bin width goes from the first to the last bin with data", () => {
    const state = chart("histogram", { bins: { column: "line_total", width: 10 } });
    const rows = result(["__bin", "__bin_start", "__bin_end", "count"], [
      [-2, -20, -10, 1],
      [1, 10, 20, 2],
    ]);
    const { bins } = histogramBins(state, rows);
    expect(bins.map((b) => [b.index, b.start, b.value])).toEqual([
      [-2, -20, 1],
      [-1, -10, 0],
      [0, 0, 0],
      [1, 10, 2],
    ]);
    expect(binLabel({ index: 0, start: 0.1, end: 0.15, value: 0 })).toBe("0.1 – 0.15");
  });
});

describe("country matching", () => {
  it("matches ISO-2, ISO-3 and names in their common forms", () => {
    for (const v of ["US", "usa", "USA", "United States", "United States of America", "U.S.A.", " united states "]) expect(matchCountry(v)).toBe("US");
    for (const v of ["RU", "RUS", "Russia", "Russian Federation"]) expect(matchCountry(v)).toBe("RU");
    expect(matchCountry("Côte d'Ivoire")).toBe("CI");
    expect(matchCountry("Ivory Coast")).toBe("CI");
    expect(matchCountry("Korea, Republic of")).toBe("KR");
    expect(matchCountry("The Netherlands")).toBe("NL");
    expect(matchCountry("Bosnia & Herzegovina")).toBe("BA");
    expect(matchCountry("Kosovo")).toBe("Kosovo"); // a shape without an ISO code
    expect(matchCountry("Chad")).toBe("TD"); // a name, not read as a code
    expect(matchCountry("Narnia")).toBeNull();
    expect(matchCountry("")).toBeNull();
    expect(normalizeCountry("  São Tomé & Príncipe ")).toBe("sao tome and principe");
  });

  it("adds up rows of the same country and lists the unmatched", () => {
    const m = matchRows([
      { name: "USA", value: 2 },
      { name: "United States", value: 3 },
      { name: "Narnia", value: 1 },
      { name: "Narnia", value: 1 },
    ]);
    expect(m.values.get("US")).toBe(5);
    expect(m.labels.get("US")).toEqual(["USA", "United States"]);
    expect(m.unmatched).toEqual(["Narnia"]);
    expect(unmatchedNotice(["A", "B", "C"], 2)).toBe("3 values couldn't be matched to a country: A, B, +1 more.");
    expect(unmatchedNotice([])).toBeNull();
  });

  it("uses dataset value labels first, so bad names can be fixed there", () => {
    const state = chart("world_map", { dimensions: ["country"], metrics: ["count"] });
    const rows = result(["country", "count"], [
      ["Yugoslavia", 4],
      ["Germany", 1],
      [null, 9],
    ]);
    const match = worldMatch(state, rows, dataset);
    expect([...match.values.entries()]).toEqual([
      ["RS", 4],
      ["DE", 1],
    ]);
    const option = worldMapOption(state, match, dataset, { colors: COLORS, tokens: TOKENS });
    expect((option.series as { nameProperty: string; data: { name: string }[] }[])[0]).toMatchObject({ nameProperty: "key", data: [{ name: "RS" }, { name: "DE" }] });
  });
});

describe("pivot date buckets", () => {
  it("marks incomplete periods in headers and rows", () => {
    const rows = result(["order_date@month", "status", "__row_level", "__col_level", "count"], [
      ["2026-01-01", "paid", 1, 1, 1],
      ["2026-02-01", "paid", 1, 1, 2],
      ["2026-03-01", "paid", 1, 1, 3],
    ]);
    const layout = pivotLayout(rows, {
      rows: ["order_date@month"],
      cols: ["status"],
      metrics: ["count"],
      totals: false,
      display: {},
      dataset,
      // Data from Jan 15 to Mar 10: January and March are incomplete.
      coverageFor: () => ({ dataMin: "2026-01-15", dataMax: "2026-03-10" }),
    });
    expect(layout.body.map((r) => [r.label, Boolean(r.incomplete)])).toEqual([
      ["Jan 2026", true],
      ["Feb 2026", false],
      ["Mar 2026", true],
    ]);
    expect(layout.hasIncomplete).toBe(true);
    expect(layout.header[0]![0]!.label).toBe("order_date · by month");
  });
});
