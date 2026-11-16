import { describe, expect, it } from "vitest";
import type { Dataset, DashboardFilterDef } from "../api.ts";
import { DATASET } from "../charts/testData.ts";
import {
  allDefault,
  crossFiltersFor,
  filtersForChart,
  parentFilters,
  readCrossFilters,
  toggleCross,
  writeCrossFilters,
  isActive,
  readFilterValues,
  selectionText,
  targetsChart,
  tileFilterStatus,
  withDefaults,
  writeFilterValues,
} from "./filters.ts";

const def = (d: Partial<DashboardFilterDef> & Pick<DashboardFilterDef, "id" | "kind">): DashboardFilterDef => ({
  label: "",
  column: null,
  dataset_id: null,
  targets: null,
  default: {},
  ...d,
});

const STATUS = def({ id: "st", kind: "values", column: "status", dataset_id: 4, default: { values: ["shipped"] } });
const PERIOD = def({ id: "t", kind: "time", label: "Period" });
const TOTAL = def({ id: "q", kind: "range", column: "line_total" });
const DEFS = [STATUS, PERIOD, TOTAL];

const NO_TIME: Dataset = { ...DATASET, id: 9, main_time_column: null, columns: DATASET.columns.filter((c) => c.name !== "order_date") };

describe("dashboard filter values in the URL", () => {
  it("reads the URL, else the saved defaults; broken parameters fall back to the default", () => {
    const search = new URLSearchParams({ f_t: JSON.stringify({ time_range: { kind: "last_30_days" } }), f_q: "{not json" });
    expect(readFilterValues(search, DEFS)).toEqual({
      st: { values: ["shipped"] },
      t: { time_range: { kind: "last_30_days" } },
      q: {},
    });
  });

  it("writes only values that differ from the defaults and keeps other parameters", () => {
    const search = new URLSearchParams({ tab: "x", f_old: "1" });
    const values = { st: { values: ["shipped"] }, t: { time_range: { kind: "this_year" as const } }, q: { min: 2 } };
    const next = writeFilterValues(search, DEFS, values);
    expect(next.get("tab")).toBe("x");
    expect(next.has("f_st")).toBe(false); // the default
    expect(next.has("f_old")).toBe(false);
    expect(JSON.parse(next.get("f_q")!)).toEqual({ min: 2 });
    expect(readFilterValues(next, DEFS)).toEqual(values);
    // A cleared filter whose default isn't empty is written as {} (shareable).
    const cleared = writeFilterValues(search, DEFS, { ...values, st: {} });
    expect(cleared.get("f_st")).toBe("{}");
    expect(readFilterValues(cleared, DEFS).st).toEqual({});
  });

  it("knows when every value is the default, and saves the current values as defaults", () => {
    const values = readFilterValues(new URLSearchParams(), DEFS);
    expect(allDefault(DEFS, values)).toBe(true);
    const changed = { ...values, q: { max: 10 } };
    expect(allDefault(DEFS, changed)).toBe(false);
    const saved = withDefaults(DEFS, changed);
    expect(saved[2]!.default).toEqual({ max: 10 });
    expect(allDefault(saved, changed)).toBe(true);
  });

  it("an empty selection or a custom range without dates filters nothing", () => {
    expect(isActive("values", { values: [] })).toBe(false);
    expect(isActive("time", { time_range: { kind: "none" } })).toBe(false);
    expect(isActive("time", { time_range: { kind: "custom", start: null, end: null } })).toBe(false);
    expect(isActive("time", { time_range: { kind: "custom", start: "2026-01-01" } })).toBe(true);
    expect(isActive("range", { min: 0 })).toBe(true);
  });

  it("summarizes selections", () => {
    expect(selectionText(STATUS, {})).toBe("All");
    expect(selectionText(STATUS, { values: ["a", null] })).toBe("a, (empty)");
    expect(selectionText(STATUS, { values: ["1", "2", "3"] })).toBe("3 selected");
    expect(selectionText(STATUS, { values: ["1"] }, { "1": "Lethbridge" })).toBe("Lethbridge");
    expect(selectionText(PERIOD, { time_range: { kind: "last_90_days" } })).toBe("Last 90 days");
    expect(selectionText(PERIOD, { time_range: { kind: "custom", start: "2026-01-01", end: "2026-01-31" } })).toBe("2026-01-01 – 2026-01-31");
    expect(selectionText(TOTAL, { min: 2, max: 5 })).toBe("2 – 5");
    expect(selectionText(TOTAL, { max: 5 })).toBe("≤ 5");
  });
});

describe("dashboard filter targeting", () => {
  it("by default targets every chart whose dataset has the column", () => {
    expect(targetsChart(STATUS, 1, DATASET)).toBe(true);
    expect(targetsChart(def({ id: "x", kind: "values", column: "country" }), 1, DATASET)).toBe(false);
    expect(targetsChart(PERIOD, 1, DATASET)).toBe(true);
    expect(targetsChart(PERIOD, 1, NO_TIME)).toBe(false);
    // A range needs a number column.
    expect(targetsChart(TOTAL, 1, DATASET)).toBe(true);
    expect(targetsChart(def({ id: "r", kind: "range", column: "status" }), 1, DATASET)).toBe(false);
    // Hidden columns don't count.
    const hidden = { ...DATASET, columns: DATASET.columns.map((c) => (c.name === "status" ? { ...c, is_hidden: true } : c)) };
    expect(targetsChart(STATUS, 1, hidden)).toBe(false);
  });

  it("an explicit chart list overrides the column match", () => {
    const only = { ...STATUS, targets: [2] };
    expect(targetsChart(only, 1, DATASET)).toBe(false);
    expect(targetsChart(only, 2, DATASET)).toBe(true);
  });

  it("sends only the active filters that target the chart, with their values", () => {
    const values = { st: { values: ["shipped", null] }, t: { time_range: { kind: "this_year" as const } }, q: {} };
    expect(filtersForChart(DEFS, values, 1, DATASET)).toEqual([
      { id: "st", kind: "values", column: "status", values: ["shipped", null] },
      { id: "t", kind: "time", column: null, time_range: { kind: "this_year" } },
    ]);
    expect(filtersForChart(DEFS, values, 1, NO_TIME).map((f) => f.id)).toEqual(["st"]);
    expect(filtersForChart([{ ...STATUS, targets: [] }], values, 1, DATASET)).toEqual([]);
  });

  it("a tile is filtered by what the backend applied; other active filters are 'not filtered'", () => {
    const values = { st: { values: ["shipped"] }, t: { time_range: { kind: "this_year" as const } }, q: {} };
    const status = tileFilterStatus(DEFS, values, ["st"]);
    expect(status.filteredBy.map((d) => d.id)).toEqual(["st"]);
    expect(status.notFilteredBy.map((d) => d.id)).toEqual(["t"]); // q is not active
  });
});

describe("cross filters", () => {
  const SHIPPED = [{ column: "status", values: ["shipped"] }];

  it("a click selects, another element of the same chart replaces, the same element again removes", () => {
    let cross = toggleCross([], "c1", SHIPPED);
    expect(cross).toEqual([{ tile: "c1", conditions: SHIPPED }]);
    cross = toggleCross(cross, "c2", [{ column: "channel", values: ["web"] }]);
    cross = toggleCross(cross, "c1", [{ column: "status", values: ["returned"] }]);
    expect(cross.map((f) => [f.tile, f.conditions[0]!.values[0]])).toEqual([["c2", "web"], ["c1", "returned"]]);
    cross = toggleCross(cross, "c1", [{ column: "status", values: ["returned"] }]);
    expect(cross.map((f) => f.tile)).toEqual(["c2"]);
  });

  it("lives in the URL; broken values are ignored", () => {
    const search = writeCrossFilters(new URLSearchParams({ f_t: "{}" }), [{ tile: "c1", conditions: SHIPPED }]);
    expect(search.get("f_t")).toBe("{}");
    expect(readCrossFilters(search)).toEqual([{ tile: "c1", conditions: SHIPPED }]);
    expect(readCrossFilters(new URLSearchParams({ xf: "nope" }))).toEqual([]);
    expect(readCrossFilters(new URLSearchParams({ xf: '[{"tile": 1}]' }))).toEqual([]);
    expect(writeCrossFilters(search, []).has("xf")).toBe(false);
  });

  it("filters every other chart that has the column, never its own", () => {
    const cross = [{ tile: "c1", conditions: SHIPPED }, { tile: "c2", conditions: [{ column: "country", values: ["NL"] }] }];
    const own = crossFiltersFor(cross, "c1");
    expect(own.defs.map((d) => d.label)).toEqual(["country: NL"]);
    const other = crossFiltersFor(cross, "c3");
    expect(filtersForChart(other.defs, other.values, 3, DATASET)).toEqual([
      { id: "x_c1_0", kind: "values", column: "status", values: ["shipped"] },
    ]);
  });
});

describe("dependent filters", () => {
  it("sends the active values of the filters it depends on", () => {
    const city = def({ id: "ci", kind: "values", column: "city", dataset_id: 4, depends_on: ["st", "t", "q"] });
    const values = { st: { values: ["shipped"] }, t: { time_range: { kind: "this_year" as const } }, q: {} };
    expect(parentFilters(city, [...DEFS, city], values)).toEqual([
      { id: "st", kind: "values", column: "status", values: ["shipped"] },
      { id: "t", kind: "time", column: null, time_range: { kind: "this_year" } },
    ]);
    expect(parentFilters(STATUS, DEFS, values)).toEqual([]);
  });
});
