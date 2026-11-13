/** Part 13 round 2: Data panel sections, dropping columns, custom SQL completions, conditional
 * colors and series colors. Pure. */
import { describe, expect, it } from "vitest";
import type { ChartDataResult, Dataset } from "../api.ts";
import { colorRules, isPositiveNegative, POSITIVE_NEGATIVE, ruleFor, ruledItem, rulesApply } from "./colorRules.ts";
import { dropColumn, emptyHint, metricForColumn, sectionsFor, targetsFor } from "./editorSections.ts";
import { adaptToViz, defaultQuery, metricFormat, metricLabel, metricName, type ChartState } from "./model.ts";
import { cartesianLayout, pieOption } from "./options.ts";
import { applyCompletion, metricNameFor, sqlCompletions, sqlIdentifier } from "./sqlMetric.ts";
import { DATASET } from "./testData.ts";

const dataset: Dataset = {
  ...DATASET,
  columns: [
    ...DATASET.columns,
    { ...DATASET.columns[3]!, id: 80, name: "row_id", label: "Row ID", is_identifier: true },
    { ...DATASET.columns[3]!, id: 81, name: "Unit Price", label: null },
    { ...DATASET.columns[3]!, id: 82, name: "notes", generic_type: "string", effective_type: "string", is_dimension: false },
    { ...DATASET.columns[1]!, id: 83, name: "region", label: "Region" },
  ],
};

function state(viz: ChartState["vizType"], query: Partial<ChartState["query"]> = {}, display: ChartState["display"] = {}): ChartState {
  const s = adaptToViz({ vizType: "table", query: defaultQuery(dataset), display: {} }, viz, dataset);
  return { ...s, query: { ...s.query, ...query }, display: { ...s.display, ...display } };
}

function result(columns: string[], rows: unknown[][]): ChartDataResult {
  return { columns: columns.map((name) => ({ name, type: "string", db_type: "text" })), rows, row_count: rows.length, truncated: false, duration_ms: 1, sql: "" };
}

const TOKENS = { success: "#0a0", danger: "#a00", warning: "#aa0", text: "#111" };
const COLORS = ["#c1", "#c2", "#c3", "#c4", "#c5", "#c6", "#c7", "#c8", "#c9", "#c10"];

describe("Data panel sections", () => {
  it("shows only the sections a chart type uses, in order", () => {
    expect(sectionsFor(state("bar"), dataset)).toEqual(["measure", "breakdown", "time", "filter", "sort"]);
    expect(sectionsFor(state("big_number"), dataset)).toEqual(["measure", "time", "filter", "sort"]);
    expect(sectionsFor(state("gauge"), dataset)).toEqual(["measure", "time", "filter", "sort"]);
    expect(sectionsFor(state("table", {}, { mode: "raw" }), dataset)).toEqual(["measure", "time", "filter", "sort"]);
    const noTime = { ...dataset, main_time_column: null, columns: dataset.columns.filter((c) => !c.is_temporal) };
    expect(sectionsFor(state("pie"), noTime)).toEqual(["measure", "breakdown", "filter", "sort"]);
  });

  it("has a one-line hint while a section is empty", () => {
    const pie = state("pie", { dimensions: [] });
    expect(emptyHint("breakdown", pie)).toBe("Pick what the slices are, e.g. a category column.");
    expect(emptyHint("breakdown", state("pie", { dimensions: ["status"] }))).toBeNull();
    expect(emptyHint("measure", state("bar", { metrics: [] }))).toMatch(/^Pick what to count or add up/);
    expect(emptyHint("filter", state("bar"))).toBe("No filters: every row counts.");
    expect(emptyHint("time", state("pie", { time: null }))).toMatch(/^All of the data/);
    expect(emptyHint("time", state("line"))).toBeNull(); // has a grain
  });
});

describe("dropping a column", () => {
  const patch = (r: ReturnType<typeof dropColumn>) => {
    if ("refused" in r) throw new Error(r.refused);
    return r.patch;
  };

  it("on What to measure: sums numbers, counts distinct identifiers and text", () => {
    expect(metricForColumn(dataset.columns[3]!)).toEqual({ column: "line_total", aggregate: "SUM" });
    expect(metricForColumn(dataset.columns[4]!)).toEqual({ column: "row_id", aggregate: "COUNT_DISTINCT" });
    expect(patch(dropColumn(state("bar"), dataset, "measure", "line_total")).metrics).toEqual(["count", { column: "line_total", aggregate: "SUM" }]);
    // One metric charts replace it.
    expect(patch(dropColumn(state("pie"), dataset, "measure", "line_total")).metrics).toEqual([{ column: "line_total", aggregate: "SUM" }]);
    expect(dropColumn(state("bar", { metrics: [{ column: "line_total", aggregate: "SUM" }] }), dataset, "measure", "line_total")).toEqual({ refused: "line_total is already measured." });
    // Raw records: the column is listed.
    expect(patch(dropColumn(state("table", {}, { mode: "raw" }), dataset, "measure", "status")).columns).toEqual(["status"]);
  });

  it("on Break it down by: the x axis first, then the series", () => {
    const empty = state("bar", { dimensions: [], time: null });
    expect(patch(dropColumn(empty, dataset, "breakdown", "status"))).toMatchObject({ dimensions: ["status"] });
    const withX = state("bar", { dimensions: ["status"], time: null });
    expect(patch(dropColumn(withX, dataset, "breakdown", "channel"))).toEqual({ series: "channel" });
    // A time column becomes the time axis.
    expect(patch(dropColumn(withX, dataset, "breakdown", "order_date"))).toMatchObject({ dimensions: [], time: { column: "order_date", grain: "month" } });
    // Columns that aren't dimensions can't group.
    expect(dropColumn(empty, dataset, "breakdown", "notes")).toEqual({ refused: expect.stringMatching(/can't be used to group by/) as string });
  });

  it("follows each chart type's shape", () => {
    expect(patch(dropColumn(state("pie"), dataset, "breakdown", "channel")).dimensions).toEqual(["channel"]);
    expect(patch(dropColumn(state("treemap", { dimensions: ["status"] }), dataset, "breakdown", "channel")).dimensions).toEqual(["status", "channel"]);
    expect(patch(dropColumn(state("histogram"), dataset, "breakdown", "line_total")).bins).toMatchObject({ column: "line_total" });
    expect(dropColumn(state("histogram"), dataset, "breakdown", "status")).toEqual({ refused: expect.stringMatching(/isn't a number column/) as string });
    // Pivot: rows first (at most 3), then columns.
    expect(patch(dropColumn(state("pivot_table", { dimensions: ["status"] }), dataset, "breakdown", "channel")).dimensions).toEqual(["status", "channel"]);
    const full = state("pivot_table", { dimensions: ["status", "channel", "order_date"] });
    expect(patch(dropColumn(full, dataset, "breakdown", "region")).column_dimensions).toEqual(["region"]);
    expect(dropColumn(full, dataset, "breakdown", "status")).toEqual({ refused: "Status is already in the table." });
  });

  it("on Over time and Filter", () => {
    expect(patch(dropColumn(state("pie"), dataset, "time", "order_date")).time).toMatchObject({ column: "order_date" });
    expect(dropColumn(state("pie"), dataset, "time", "status")).toEqual({ refused: expect.stringMatching(/isn't a time column/) as string });
    expect(patch(dropColumn(state("bar"), dataset, "filter", "status")).filters).toEqual([{ column: "status", operator: "=", value: "" }]);
  });

  it("lists where a column can go (the keyboard way)", () => {
    expect(targetsFor(state("bar"), dataset, "line_total")).toEqual(["measure", "filter"]);
    expect(targetsFor(state("bar"), dataset, "order_date")).toEqual(["measure", "breakdown", "time", "filter"]);
  });
});

describe("custom SQL metrics", () => {
  it("are named by their label and use their own number format", () => {
    const ref = { sql: "SUM(a) / NULLIF(SUM(b), 0)", label: "Price per unit", number_format: "$0,0.00" };
    expect(metricName(ref)).toBe("Price per unit");
    expect(metricLabel(ref, dataset)).toBe("Price per unit");
    expect(metricFormat(ref, dataset)).toBe("$0,0.00");
  });

  it("complete column names (quoted when needed) and functions", () => {
    const columns = dataset.columns;
    const done = sqlCompletions("SUM(line", 8, columns, "postgresql");
    expect(done?.items.map((i) => i.label)).toEqual(["line_total"]);
    expect(applyCompletion("SUM(line", done!, done!.items[0]!)).toEqual({ text: "SUM(line_total", cursor: 14 });
    // A name with capitals and a space is quoted for the database.
    const unit = sqlCompletions("SUM(Uni", 7, columns, "postgresql");
    expect(unit?.items[0]?.insert).toBe('"Unit Price"');
    expect(sqlCompletions('SUM("Unit P', 11, columns, "postgresql")?.items[0]?.insert).toBe('"Unit Price"');
    expect(sqlCompletions("SUM(Uni", 7, columns, "mysql")?.items[0]?.insert).toBe("`Unit Price`");
    // Functions, by prefix.
    expect(sqlCompletions("nul", 3, columns, "postgresql")?.items.map((i) => i.label)).toEqual(["NULLIF"]);
    // Never inside a string, never for nothing typed.
    expect(sqlCompletions("COUNT(CASE WHEN status = 'li", 28, columns, "postgresql")).toBeNull();
    expect(sqlCompletions("SUM(", 4, columns, "postgresql")).toBeNull();
    expect(sqlIdentifier("line_total", "postgresql")).toBe("line_total");
  });

  it("get a unique saved-metric name", () => {
    expect(metricNameFor("Price per unit", ["count"])).toBe("price_per_unit");
    expect(metricNameFor("Price per unit", ["price_per_unit"])).toBe("price_per_unit_2");
    expect(metricNameFor("Marge (€) brute", [])).toBe("marge_brute");
    expect(metricNameFor("!!!", [])).toBe("metric");
  });
});

describe("conditional colors", () => {
  it("match the first rule, per metric", () => {
    const rules = [
      { when: "above" as const, value: 100, tone: "success" as const, metric: "revenue" },
      { when: "below" as const, value: 0, tone: "danger" as const },
      { when: "above" as const, value: 10, tone: "warning" as const },
    ];
    expect(ruleFor(150, "revenue", rules)?.tone).toBe("success");
    expect(ruleFor(150, "count", rules)?.tone).toBe("warning");
    expect(ruleFor("-3", "count", rules)?.tone).toBe("danger");
    expect(ruleFor(5, "count", rules)).toBeNull();
    expect(ruleFor(null, "count", rules)).toBeNull();
    expect(ruleFor(0, "count", POSITIVE_NEGATIVE)).toBeNull();
  });

  it("read the big number's older thresholds as rules", () => {
    expect(colorRules({ color_below: 5, color_above: 10 })).toEqual([
      { when: "below", value: 5, tone: "danger" },
      { when: "above", value: 10, tone: "success" },
    ]);
    expect(isPositiveNegative(POSITIVE_NEGATIVE)).toBe(true);
    expect(rulesApply("heatmap")).toBe(false);
    expect(rulesApply("pie")).toBe(true);
  });

  it("never rely on color alone: a colored value shows its label with a marker", () => {
    const item = ruledItem(-5, "count", POSITIVE_NEGATIVE, TOKENS, String) as { itemStyle: { color: string }; label: { show: boolean; formatter(): string } };
    expect(item.itemStyle.color).toBe("#a00");
    expect(item.label.show).toBe(true);
    expect(item.label.formatter()).toBe("▼ -5");
    expect(ruledItem(0, "count", POSITIVE_NEGATIVE, TOKENS, String)).toBe(0);
  });

  it("color bars and slices", () => {
    const bar = state("bar", { dimensions: ["status"], time: null, metrics: ["count"] }, { color_rules: POSITIVE_NEGATIVE });
    const layout = cartesianLayout(bar, result(["status", "count"], [["a", 5], ["b", -2], ["c", 0]]), dataset, { colors: COLORS, tokens: TOKENS });
    const data = (layout.option.series as { data: unknown[] }[])[0]!.data;
    // Bars by value (largest first); 0 matches no rule and stays plain.
    expect(data).toEqual([
      expect.objectContaining({ value: 5, itemStyle: { color: "#0a0" } }),
      0,
      expect.objectContaining({ value: -2, itemStyle: { color: "#a00" } }),
    ]);
    const pie = state("pie", { dimensions: ["status"], metrics: ["count"] }, { color_rules: [{ when: "above", value: 4, tone: "warning" }] });
    const option = pieOption(pie, result(["status", "__other", "count"], [["a", 0, 5], ["b", 0, 2]]), dataset, { colors: COLORS, tokens: TOKENS });
    const slices = (option.series as { data: { name: string; itemStyle?: { color: string }; label?: { formatter: string } }[] }[])[0]!.data;
    expect(slices[0]).toMatchObject({ itemStyle: { color: "#aa0" }, label: { formatter: "a\n▲ 5" } });
    expect(slices[1]!.itemStyle?.color).toBe("#c2");
  });

  it("let each series have its own color", () => {
    const bar = state("bar", { dimensions: ["status"], series: "channel", time: null, metrics: ["count"] }, { series_colors: { web: 5 } });
    const layout = cartesianLayout(bar, result(["status", "channel", "count"], [["a", "store", 1], ["a", "web", 2]]), dataset, { colors: COLORS });
    const series = layout.option.series as { name: string; itemStyle?: { color: string } }[];
    expect(series.find((s) => s.name === "web")?.itemStyle?.color).toBe("#c5");
    expect(series.find((s) => s.name === "store")?.itemStyle?.color).toBe("#c1");
  });
});
