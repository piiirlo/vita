import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChartDataResult, Dataset } from "../api.ts";
import { adaptToViz, defaultQuery } from "./model.ts";
import TableChart from "./TableChart.tsx";
import { DATASET } from "./testData.ts";

describe("TableChart", () => {
  it("shows value labels instead of raw values, and the chart's number format", () => {
    const dataset: Dataset = {
      ...DATASET,
      columns: DATASET.columns.map((c) => (c.name === "status" ? { ...c, value_labels: { "1": "Lethbridge" } } : c)),
    };
    const base = adaptToViz({ vizType: "table", query: defaultQuery(dataset), display: {} }, "table", dataset);
    const state = {
      ...base,
      query: { ...base.query, dimensions: ["status"], metrics: ["revenue"] },
      display: { formats: { revenue: { preset: "compact" as const } } },
    };
    const result: ChartDataResult = {
      columns: [
        { name: "status", type: "number", db_type: "int4" },
        { name: "revenue", type: "number", db_type: "numeric" },
      ],
      rows: [
        [1, 12345],
        [2, 99],
      ],
      row_count: 2,
      truncated: false,
      duration_ms: 1,
      sql: "",
    };
    render(<TableChart state={state} result={result} dataset={dataset} />);
    expect(screen.getByText("Lethbridge")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // no label: the value itself
    expect(screen.getByText("12.3K")).toBeInTheDocument(); // the chart's format beats the metric's "$0,0.00"
  });
});
