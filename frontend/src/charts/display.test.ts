import { describe, expect, it } from "vitest";
import type { Dataset } from "../api.ts";
import {
  bucketEnd,
  changeRatio,
  drawState,
  formatWithSpec,
  incompleteBuckets,
  metricFormatter,
  numeralFormat,
  planLabels,
  previousRange,
  unavailableOptions,
} from "./display.ts";
import { adaptToViz, defaultQuery, type ChartState } from "./model.ts";
import { DATASET } from "./testData.ts";

const dataset: Dataset = DATASET;
const base = (viz: ChartState["vizType"], patch: Partial<ChartState["query"]> = {}, display: ChartState["display"] = {}): ChartState => {
  const s = adaptToViz({ vizType: "table", query: defaultQuery(dataset), display: {} }, viz, dataset);
  return { ...s, query: { ...s.query, ...patch }, display: { ...s.display, ...display } };
};

describe("number formats", () => {
  it("formats each preset, with decimals, symbol, prefix and suffix", () => {
    expect(formatWithSpec(67416.513, { preset: "number" })).toBe("67,416.51");
    expect(formatWithSpec(67416.513, { preset: "number", decimals: 0 })).toBe("67,417");
    expect(formatWithSpec(67416.513, { preset: "currency" })).toBe("$67,416.51");
    expect(formatWithSpec(-1234.5, { preset: "currency", symbol: "€" })).toBe("-€1,234.50");
    expect(formatWithSpec(0.1254, { preset: "percent" })).toBe("12.5%");
    expect(formatWithSpec(0.1254, { preset: "percent", decimals: 0 })).toBe("13%");
    expect(formatWithSpec(67416.513, { preset: "compact" })).toBe("67.4K");
    expect(formatWithSpec(2_500_000, { preset: "compact", decimals: 2 })).toBe("2.50M");
    expect(formatWithSpec(3.14159, { preset: "custom", custom: "0.000" })).toBe("3.142");
    expect(formatWithSpec(12, { preset: "number", prefix: "~", suffix: " rentals" })).toBe("~12 rentals");
    expect(formatWithSpec(null, { preset: "currency" })).toBe("–");
    expect(numeralFormat({ preset: "custom", custom: "  " })).toBe("0,0.[00]");
  });

  it("the chart's format wins over the metric's own, and ad-hoc metrics can be formatted", () => {
    // "revenue" is a saved metric with format "$0,0.00" in the test dataset.
    expect(metricFormatter({}, "revenue", dataset)(1234.5)).toBe("$1,234.50");
    expect(metricFormatter({ formats: { revenue: { preset: "compact" } } }, "revenue", dataset)(1234.5)).toBe("1.2K");
    const adhoc = { column: "line_total", aggregate: "SUM" as const, label: null };
    expect(metricFormatter({}, adhoc, dataset)(1234.5)).toBe("1,234.5");
    expect(metricFormatter({ formats: { "SUM(line_total)": { preset: "currency", decimals: 0 } } }, adhoc, dataset)(1234.5)).toBe("$1,235");
  });
});

describe("options that don't apply", () => {
  it("disables Stacked without a series, with a hint", () => {
    expect(unavailableOptions(base("bar"), dataset).stacked).toBe("Add a series to stack bars");
    expect(unavailableOptions(base("bar", { series: "status" }), dataset).stacked).toBeUndefined();
    // Two metrics are two series too.
    expect(unavailableOptions(base("bar", { metrics: ["count", "revenue"] }), dataset).stacked).toBeUndefined();
  });

  it("explains the rest: legend, single color, sort, tables, big numbers", () => {
    expect(unavailableOptions(base("line"), dataset).legend).toMatch(/One series/);
    expect(unavailableOptions(base("line", { series: "status" }), dataset).single_color).toMatch(/single series/);
    const timeBars = base("bar", { dimensions: [], time: { column: "order_date", grain: "month", range: { kind: "none" } } });
    expect(unavailableOptions(timeBars, dataset).sort).toMatch(/date order/);
    const table = unavailableOptions(base("table"), dataset);
    expect(table.legend).toBe("Tables have no legend");
    expect(table.axis_titles).toBe("Tables have no axes");
    const big = base("big_number");
    expect(unavailableOptions(big, dataset).compare_previous).toMatch(/Set a time range/);
    const ranged = base("big_number", { time: { column: "order_date", grain: null, range: { kind: "last_30_days" } } });
    expect(unavailableOptions(ranged, dataset).compare_previous).toBeUndefined();
    expect(unavailableOptions({ ...ranged, display: { show_trend: false } }, dataset).trend_dates).toMatch(/trend line first/);
  });
});

describe("drawState", () => {
  it("draws a loaded result with the current look but its own query options", () => {
    const shown = base("bar", { series: "status" }, { stacked: false });
    const current = { ...shown, display: { stacked: true, horizontal: true, color: 3 } };
    expect(drawState(shown, current).display).toEqual({ stacked: true, horizontal: true, color: 3 });
    expect(drawState(shown, current).query).toBe(shown.query);
    // Options that need a new query keep the shown result's value.
    const big = base("big_number", {}, { show_trend: true });
    expect(drawState(big, { ...big, display: { show_trend: false, font_size: "l" } }).display).toEqual({ show_trend: true, font_size: "l" });
    // A result of another chart type is drawn as it was made.
    expect(drawState(shown, base("line"))).toBe(shown);
  });
});

describe("previous period", () => {
  it("moves the range back by its length (whole months by months), clipped to today", () => {
    expect(previousRange("last_30_days", "2026-10-11", "2026-11-10", "2026-11-10")).toEqual({ start: "2026-09-10", end: "2026-10-10" });
    expect(previousRange("custom", "2022-04-01", "2022-06-30", "2026-11-10")).toEqual({ start: "2022-01-01", end: "2022-03-31" });
    // Not whole months: the same number of days before.
    expect(previousRange("custom", "2022-04-05", "2022-04-11", "2026-11-10")).toEqual({ start: "2022-03-29", end: "2022-04-04" });
  });

  it("moves calendar ranges back by their unit (this year so far vs the same days last year)", () => {
    expect(previousRange("this_year", "2026-01-01", "2026-12-31", "2026-11-10")).toEqual({ start: "2025-01-01", end: "2025-11-10" });
    expect(previousRange("last_year", "2025-01-01", "2025-12-31", "2026-11-10")).toEqual({ start: "2024-01-01", end: "2024-12-31" });
    expect(previousRange("last_12_months", "2025-11-10", "2026-11-10", "2026-11-10")).toEqual({ start: "2024-11-10", end: "2025-11-10" });
    expect(previousRange("custom", "2024-02-29", "2024-03-01", "2026-01-01")).toEqual({ start: "2024-02-27", end: "2024-02-28" });
  });

  it("needs a closed range", () => {
    expect(previousRange("custom", "2026-01-01", null, "2026-11-10")).toBeNull();
    expect(previousRange("custom", "2027-01-01", "2027-02-01", "2026-11-10")).toBeNull();
  });

  it("computes the change", () => {
    expect(changeRatio(110, 100)).toBeCloseTo(0.1);
    expect(changeRatio("90", -100)).toBeCloseTo(1.9);
    expect(changeRatio(5, 0)).toBeNull();
    expect(changeRatio(5, null)).toBeNull();
  });
});

describe("incomplete periods", () => {
  const months = ["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"];

  it("marks the current month when the range ends inside it", () => {
    expect([...incompleteBuckets(months, "month", { rangeStart: "2026-08-01", rangeEnd: "2026-11-10" })]).toEqual([3]);
  });

  it("marks the first / last month of the dataset when the data starts or ends inside them", () => {
    const pagila = ["2022-01-01", "2022-02-01", "2022-07-01"];
    expect([...incompleteBuckets(pagila, "month", { dataMin: "2022-01-23T10:00:00", dataMax: "2022-07-27T23:59:00" })].sort()).toEqual([0, 2]);
  });

  it("leaves whole periods alone", () => {
    expect(incompleteBuckets(months, "month", { rangeStart: "2026-08-01", rangeEnd: "2026-11-30" }).size).toBe(0);
    expect(incompleteBuckets(months, "month", { dataMin: "2026-08-01", dataMax: "2026-11-30" }).size).toBe(0);
    expect(incompleteBuckets(months, "month", {}).size).toBe(0);
    expect(incompleteBuckets(months, null, { rangeEnd: "2026-11-10" }).size).toBe(0);
    // A day is complete as soon as it has data.
    expect(incompleteBuckets(["2026-11-09", "2026-11-10"], "day", { dataMax: "2026-11-10T08:00:00" }).size).toBe(0);
  });

  it("knows where each grain's bucket ends", () => {
    expect(bucketEnd("2026-11-09", "week")).toBe("2026-11-16");
    expect(bucketEnd("2026-01-31", "month")).toBe("2026-02-28");
    expect(bucketEnd("2026-10-01", "quarter")).toBe("2027-01-01");
    expect(bucketEnd("2026-01-01", "year")).toBe("2027-01-01");
  });
});

describe("axis labels", () => {
  const films = ["ZORRO ARK", "GOODFELLAS SALUTE", "SATURDAY LAMBS", "TITANS JERK", "TORQUE BOUND", "HARRY IDAHO", "INNOCENT USUAL"];

  it("keeps short labels flat", () => {
    expect(planLabels(["a", "b", "c"], 800, false)).toMatchObject({ rotate: 0, interval: 0, crowded: false });
  });

  it("rotates long labels (never hides them) and suggests horizontal bars", () => {
    const plan = planLabels([...films, ...films.map((f) => `${f} 2`)], 1000, false);
    expect(plan).toMatchObject({ rotate: 45, interval: 0, crowded: false, suggestHorizontal: true });
  });

  it("cuts very long labels with an ellipsis", () => {
    const plan = planLabels(["A VERY LONG FILM TITLE THAT GOES ON AND ON", "B"], 300, false);
    expect(plan.truncated).toBe(true);
    expect(plan.maxWidth).toBe(140);
  });

  it("says so when even rotated labels can't all fit", () => {
    const many = Array.from({ length: 200 }, (_, i) => `Category ${i}`);
    expect(planLabels(many, 600, false)).toMatchObject({ interval: "auto", crowded: true, suggestHorizontal: true });
  });

  it("keeps every label when the size is unknown, and gives horizontal bars a label column", () => {
    expect(planLabels(films, 0, false)).toMatchObject({ interval: 0, rotate: 0 });
    expect(planLabels(films, 1000, true)).toMatchObject({ interval: 0, rotate: 0, maxWidth: 220 });
  });
});
