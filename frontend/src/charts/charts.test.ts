import { describe, expect, it } from "vitest";
import type { ChartDataResult } from "../api.ts";
import { categoryLabel, formatBucket, formatNumber, toNumber } from "./format.ts";
import { adaptToViz, chartRequests, completeFilters, defaultQuery, type ChartState } from "./model.ts";
import { cartesianOption, pivot, sortCategories } from "./options.ts";
import { DATASET } from "./testData.ts";

function result(columns: string[], rows: unknown[][]): ChartDataResult {
  return {
    columns: columns.map((name) => ({ name, type: "string", db_type: "text" })),
    rows,
    row_count: rows.length,
    truncated: false,
    duration_ms: 1,
    sql: "SELECT …",
  };
}

describe("format", () => {
  it("formats numbers with numeral formats, also from numeric strings", () => {
    expect(formatNumber(1234.567, "0,0.00")).toBe("1,234.57");
    expect(formatNumber(0.1234, "0.0%")).toBe("12.3%");
    expect(formatNumber("2.0188103711235384", "0.00")).toBe("2.02");
    expect(formatNumber(1500, "0.0a")).toBe("1.5k");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatNumber(null)).toBe("–");
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber("abc")).toBeNull();
  });

  it("formats time buckets by grain", () => {
    expect(formatBucket("2025-03-01", "month")).toBe("Mar 2025");
    expect(formatBucket("2025-04-01", "quarter")).toBe("Q2 2025");
    expect(formatBucket("2025-01-01", "year")).toBe("2025");
    expect(formatBucket("2025-03-03", "week")).toBe("Mar 3, 2025");
    expect(categoryLabel(null)).toBe("(empty)");
  });
});

describe("model", () => {
  const base: ChartState = { vizType: "table", query: defaultQuery(DATASET), display: {} };

  it("adapts the query when switching chart type", () => {
    const line = adaptToViz({ ...base, query: { ...base.query, dimensions: ["status"] } }, "line", DATASET);
    expect(line.query.time?.grain).toBe("month");
    expect(line.query.dimensions).toEqual([]);
    expect(line.query.series).toBe("status"); // the dimension becomes the series

    const big = adaptToViz({ ...line, query: { ...line.query, metrics: ["revenue", "count"] } }, "big_number", DATASET);
    expect(big.query.metrics).toEqual(["revenue"]);
    expect(big.query.series).toBeNull();
    expect(big.display.show_trend).toBe(true);

    const bar = adaptToViz({ ...base, query: { ...base.query, dimensions: ["channel", "status"] } }, "bar", DATASET);
    expect(bar.query.dimensions).toEqual(["channel"]);
    expect(bar.query.time?.grain).toBeNull();

    const table = adaptToViz(line, "table", DATASET);
    expect(table.query.series).toBeNull();
    expect(table.query.dimensions).toEqual(["status"]);
  });

  it("sends two requests for a big number with a trend", () => {
    const state: ChartState = {
      vizType: "big_number",
      query: { ...base.query, metrics: ["revenue"], time: { column: "order_date", grain: "month", range: { kind: "last_year" } } },
      display: { show_trend: true },
    };
    const { main, trend } = chartRequests(state);
    expect(main.time).toEqual({ column: "order_date", grain: null, range: { kind: "last_year" } });
    expect(trend?.time?.grain).toBe("month");
    expect(chartRequests({ ...state, display: {} }).trend).toBeNull();
  });

  it("leaves out filters that are still being filled in", () => {
    expect(
      completeFilters([
        { column: "status", operator: "=", value: "" },
        { column: "status", operator: "IN", value: [] },
        { column: "status", operator: "BETWEEN", value: ["a", ""] },
        { column: "status", operator: "IS NULL", value: null },
        { column: "status", operator: "!=", value: "x" },
      ]).map((f) => f.operator),
    ).toEqual(["IS NULL", "!="]);
  });
});

describe("options", () => {
  const rows = [
    ["2025-01-01", "web", 10],
    ["2025-01-01", "mobile", 5],
    ["2025-02-01", "web", 12],
    ["2025-02-01", null, 1],
  ];

  it("pivots rows into one series per series value, with gaps as null", () => {
    const p = pivot(result(["order_date", "channel", "revenue"], rows), "order_date", "channel", ["revenue"], DATASET);
    expect(p.categories).toEqual(["2025-01-01", "2025-02-01"]);
    expect(p.series.map((s) => [s.name, s.values])).toEqual([
      ["web", [10, 12]],
      ["mobile", [5, null]],
      ["(empty)", [null, 1]],
    ]);
  });

  it("sorts bar categories by total value or by label", () => {
    const p = pivot(result(["status", "count"], [["b", 1], ["a", 5], [null, 3]]), "status", null, ["count"], DATASET);
    expect(sortCategories(p, "value", "count").categories).toEqual(["a", null, "b"]);
    expect(sortCategories(p, "label", "count").categories).toEqual(["a", "b", null]);
  });

  it("builds a stacked horizontal bar option with grain labels", () => {
    const state: ChartState = {
      vizType: "bar",
      query: { ...defaultQuery(DATASET), metrics: ["revenue"], series: "channel", time: { column: "order_date", grain: "month", range: { kind: "none" } } },
      display: { stacked: true, horizontal: true },
    };
    const option = cartesianOption(state, result(["order_date", "channel", "revenue"], rows), DATASET);
    expect((option.yAxis as { data: string[] }).data).toEqual(["Jan 2025", "Feb 2025"]);
    const series = option.series as { stack?: string; type: string }[];
    expect(series).toHaveLength(3);
    expect(series.every((s) => s.type === "bar" && s.stack === "total")).toBe(true);
    expect(option.legend).toBeDefined();
  });
});
