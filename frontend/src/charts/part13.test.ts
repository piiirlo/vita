/** Part 13 round 1: year numbers and text dates as time columns, raw values, line / area over a
 * dimension, and the time column checks that run before any query. */
import { describe, expect, it } from "vitest";
import type { ChartDataResult, Dataset } from "../api.ts";
import { dimensionOptions } from "./dimensions.ts";
import { bucketGrain, categoryLabel, formatBucket } from "./format.ts";
import { adaptToViz, defaultQuery, grainAllowed, missingFor, timeColumnProblem, type ChartState } from "./model.ts";
import { cartesianLayout } from "./options.ts";
import { DATASET } from "./testData.ts";

const year = { ...DATASET.columns[3]!, id: 60, name: "year", label: "Year", generic_type: "number" as const, effective_type: "number" as const, is_temporal: true, time_kind: "year_number" as const };
const games: Dataset = {
  ...DATASET,
  main_time_column: "year",
  columns: [year, DATASET.columns[1]!, { ...DATASET.columns[2]!, name: "rank", label: "Rank", value_labels: { "1": "First", "2": "Second" } }, DATASET.columns[3]!],
};
const noTime: Dataset = { ...DATASET, main_time_column: null, columns: DATASET.columns.slice(1) };

function state(dataset: Dataset, viz: ChartState["vizType"], query: Partial<ChartState["query"]> = {}): ChartState {
  const s = adaptToViz({ vizType: "table", query: defaultQuery(dataset), display: {} }, viz, dataset);
  return { ...s, query: { ...s.query, ...query } };
}

function result(columns: string[], rows: unknown[][]): ChartDataResult {
  return { columns: columns.map((name) => ({ name, type: "string", db_type: "text" })), rows, row_count: rows.length, truncated: false, duration_ms: 1, sql: "" };
}

describe("year numbers as time", () => {
  it("only allow the year grain", () => {
    expect(grainAllowed(year, "year")).toBe(true);
    expect(grainAllowed(year, "month")).toBe(false);
    expect(grainAllowed(year, "raw")).toBe(false);
    expect(grainAllowed(DATASET.columns[0], "day")).toBe(true);
  });

  it("default to the year grain when a line chart is picked", () => {
    expect(state(games, "line").query.time?.grain).toBe("year");
    expect(state(DATASET, "line").query.time?.grain).toBe("month");
  });

  it("are checked before any query runs", () => {
    expect(timeColumnProblem(state(games, "line"), games)).toBeNull();
    const monthly = state(games, "line", { time: { column: "year", grain: "month", range: { kind: "none" } } });
    expect(timeColumnProblem(monthly, games)).toMatchObject({ title: "“Year” only has years", hint: "This column only has years: use the Year grain." });
    const heatmap = state(games, "heatmap", { dimensions: ["year@month_of_year", "status"] });
    expect(timeColumnProblem(heatmap, games)?.title).toBe("“Year” only has years");
  });

  it("offer only the year bucket as a dimension", () => {
    const options = dimensionOptions([year], { buckets: ["month", "year"], parts: ["day_of_week", "month_of_year"] }).map((o) => o.value);
    expect(options).toEqual(["year", "year@year"]);
  });
});

describe("time column checks", () => {
  it("catch columns not checked yet, unmarked or gone", () => {
    const pending: Dataset = { ...games, columns: [{ ...year, time_kind: "pending" }, ...games.columns.slice(1)] };
    expect(timeColumnProblem(state(pending, "line"), pending)?.title).toBe("“Year” hasn't been checked as a time column yet");
    const unmarked: Dataset = { ...games, columns: [{ ...year, is_temporal: false }, ...games.columns.slice(1)] };
    const s = { ...state(games, "line") };
    expect(timeColumnProblem(s, unmarked)?.title).toBe("“Year” isn't a time column");
    const gone: Dataset = { ...games, columns: games.columns.slice(1) };
    expect(timeColumnProblem(s, gone)?.title).toBe("“year” isn't a column of this dataset anymore");
  });

  it("leave charts without time alone", () => {
    expect(timeColumnProblem(state(DATASET, "pie", { dimensions: ["status"], time: null }), DATASET)).toBeNull();
  });
});

describe("raw values", () => {
  it("label raw values with their time when there is one", () => {
    expect(formatBucket("2025-03-01", "raw")).toBe("Mar 1, 2025");
    expect(formatBucket("2025-03-01T14:30:00", "raw")).toBe("Mar 1, 2025 14:30");
    expect(formatBucket("2025-03-01T00:00:00", "raw")).toBe("Mar 1, 2025");
    expect(categoryLabel(null, "raw")).toBe("(empty)");
  });

  it("have no buckets (so no incomplete periods)", () => {
    expect(bucketGrain("raw")).toBeNull();
    expect(bucketGrain("month")).toBe("month");
  });
});

describe("line and area over a dimension", () => {
  it("is the x axis when the dataset has no time column", () => {
    const s = state(noTime, "line");
    expect(s.query.dimensions).toEqual(["status"]);
    expect(s.query.time).toBeNull();
    expect(missingFor(s, noTime)).toEqual([]);
    expect(missingFor({ ...s, query: { ...s.query, dimensions: [] } }, noTime)).toEqual([
      "Pick the x axis (a dimension), or mark a time column in the dataset",
    ]);
  });

  it("sorts categories by their label", () => {
    const s = state(games, "area", { dimensions: ["rank"], time: null, metrics: ["count"] });
    const layout = cartesianLayout(s, result(["rank", "count"], [["2", 5], [null, 1], ["10", 3], ["1", 9]]), games);
    const axis = layout.option.xAxis;
    const data = (Array.isArray(axis) ? axis[0] : axis) as { data: string[] };
    // By the shown label ("1" -> "First", "2" -> "Second"); (empty) last.
    expect(data.data).toEqual(["10", "First", "Second", "(empty)"]);
  });
});
