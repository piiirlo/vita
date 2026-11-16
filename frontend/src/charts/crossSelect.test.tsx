import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChartDataResult, GenericType } from "../api.ts";
import { countrySelection, crossSelection, sameSelection } from "./crossSelect.ts";
import { adaptToViz, defaultQuery, type ChartState } from "./model.ts";
import { cartesianLayout, pieSlices } from "./options.ts";
import { treemapTree } from "./moreCharts.ts";
import PivotTable from "./PivotTable.tsx";
import TableChart from "./TableChart.tsx";
import { DATASET } from "./testData.ts";

function chart(vizType: ChartState["vizType"], query: Partial<ChartState["query"]>): ChartState {
  const base = adaptToViz({ vizType: "table", query: defaultQuery(DATASET), display: {} }, vizType, DATASET);
  return { ...base, query: { ...base.query, time: null, ...query } };
}

const col = (name: string, type: GenericType = "string") => ({ name, type, db_type: type });
const result = (columns: string[], rows: unknown[][]): ChartDataResult => ({
  columns: columns.map((c) => col(c, c === "revenue" ? "number" : "string")),
  rows,
  row_count: rows.length,
  truncated: false,
  duration_ms: 1,
  sql: "",
});

describe("cross-filter selections", () => {
  it("only plain columns select; date buckets and time parts are left out", () => {
    expect(crossSelection([["status", "shipped"], ["order_date@month", "2026-01-01"]], DATASET)).toEqual([{ column: "status", values: ["shipped"] }]);
    expect(crossSelection([["order_date@day_of_week", 1]], DATASET)).toBeNull();
    expect(crossSelection([[undefined, "x"]], DATASET)).toBeNull();
    // An empty value selects "(empty)".
    expect(crossSelection([["status", null]], DATASET)).toEqual([{ column: "status", values: [null] }]);
  });

  it("a country selects every value that matched it", () => {
    expect(countrySelection("status", ["NL", "Netherlands"], DATASET)).toEqual([{ column: "status", values: ["NL", "Netherlands"] }]);
    expect(countrySelection("status", [], DATASET)).toBeNull();
  });

  it("compares selections regardless of order", () => {
    const a = [{ column: "status", values: ["a", "b"] }, { column: "channel", values: ["web"] }];
    const b = [{ column: "channel", values: ["web"] }, { column: "status", values: ["b", "a"] }];
    expect(sameSelection(a, b)).toBe(true);
    expect(sameSelection(a, [{ column: "status", values: ["a"] }])).toBe(false);
  });

  it("charts keep the raw values clicks map back to", () => {
    const bar = chart("bar", { dimensions: ["status"], metrics: ["revenue"] });
    const res = result(["status", "revenue"], [["b", 1], ["a", 5]]);
    expect(cartesianLayout(bar, res, DATASET).categories).toEqual(["a", "b"]); // sorted by value
    const pie = chart("pie", { dimensions: ["status"], metrics: ["revenue"] });
    const slices = pieSlices(pie, result(["status", "revenue", "__other"], [["a", 5, 0], [null, 2, 1]]), DATASET);
    expect(slices.map((s) => s.raw)).toEqual(["a", undefined]); // "Other" selects nothing
    const tree = chart("treemap", { dimensions: ["status", "channel"], metrics: ["revenue"] });
    const nodes = treemapTree(tree, result(["status", "channel", "__other", "revenue"], [["a", "web", 0, 3]]), DATASET);
    expect(nodes[0]!.path).toEqual(["a"]);
    expect(nodes[0]!.children![0]!.path).toEqual(["a", "web"]);
  });

  it("a grouped table row selects its dimension values", () => {
    const onSelect = vi.fn();
    const state = chart("table", { dimensions: ["status", "channel"], metrics: ["revenue"] });
    render(<TableChart state={state} result={result(["status", "channel", "revenue"], [["shipped", "web", 10]])} dataset={DATASET} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("shipped"));
    expect(onSelect).toHaveBeenCalledWith([
      { column: "status", values: ["shipped"] },
      { column: "channel", values: ["web"] },
    ]);
    // Keyboard too.
    fireEvent.keyDown(screen.getByText("shipped").closest("tr")!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("raw-record tables aren't clickable", () => {
    const onSelect = vi.fn();
    const state = chart("table", { columns: ["status"], metrics: [] });
    render(<TableChart state={state} result={result(["status"], [["shipped"]])} dataset={DATASET} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("shipped"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a pivot cell selects its row and column values; a total cell fewer", () => {
    const onSelect = vi.fn();
    const state = chart("pivot_table", { dimensions: ["status"], column_dimensions: ["channel"], metrics: ["revenue"], totals: true });
    const res = result(["status", "channel", "__row_level", "__col_level", "revenue"], []);
    res.columns[2]!.type = "number";
    res.columns[3]!.type = "number";
    // Levels: how many dims are grouped (1 = by the dimension, 0 = total).
    res.rows = [
      ["shipped", "web", 1, 1, 10],
      ["shipped", null, 1, 0, 10],
      [null, "web", 0, 1, 10],
      [null, null, 0, 0, 10],
    ];
    render(<PivotTable state={state} result={res} dataset={DATASET} onSelect={onSelect} />);
    const shippedRow = screen.getByRole("rowheader", { name: "shipped" }).closest("tr")!;
    const cells = within(shippedRow).getAllByRole("cell");
    fireEvent.click(cells[0]!);
    expect(onSelect).toHaveBeenLastCalledWith([
      { column: "status", values: ["shipped"] },
      { column: "channel", values: ["web"] },
    ]);
    fireEvent.click(cells[1]!); // the row's total: only the row value
    expect(onSelect).toHaveBeenLastCalledWith([{ column: "status", values: ["shipped"] }]);
  });
});
