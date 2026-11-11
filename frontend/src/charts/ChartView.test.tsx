import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChartDataResult } from "../api.ts";
import ChartView from "./ChartView.tsx";
import { clearTimeExtentCache } from "./extentCache.ts";
import { adaptToViz, defaultQuery } from "./model.ts";
import { DATASET } from "./testData.ts";

vi.mock("./EChart.tsx", () => ({ default: () => <div data-testid="echart" /> }));

const state = (() => {
  const base = adaptToViz({ vizType: "table", query: defaultQuery(DATASET), display: {} }, "big_number", DATASET);
  return { ...base, query: { ...base.query, metrics: ["count"] } };
})();

// What /api/chart-data returns for a total over Oct 1 - Nov 9, 2026.
const total = (rows: unknown[][]): ChartDataResult => ({
  columns: [{ name: "count", type: "number", db_type: "int8" }],
  rows,
  row_count: rows.length,
  truncated: false,
  duration_ms: 1,
  sql: "",
  range_start: "2026-10-01",
  range_end: "2026-11-09",
});

describe("big number: no data vs a real zero", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearTimeExtentCache();
  });

  it("no rows in the time range: '-' instead of a number, and where the data is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ column: "order_date", min: "2024-01-03", max: "2025-12-30" }), { status: 200 })),
    );
    render(<ChartView state={state} result={total([])} trend={null} dataset={DATASET} />);
    const value = screen.getByTestId("big-number-value");
    expect(value).toHaveTextContent(/^-$/);
    expect(value).toHaveAccessibleName("No data");
    expect(value).not.toHaveTextContent("0");
    const hint = screen.getByRole("status");
    expect(hint).toHaveTextContent("No data between Oct 1, 2026 and Nov 9, 2026.");
    expect(await within(hint).findByTestId("time-extent")).toHaveTextContent("This dataset has data from Jan 3, 2024 to Dec 30, 2025.");
  });

  it("rows in the range whose total is 0: shows 0 normally, no hint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ChartView state={state} result={total([[0]])} trend={null} dataset={DATASET} />);
    const value = screen.getByTestId("big-number-value");
    // CountUp: the final value for screen readers, the animated one on screen.
    expect(value.querySelector(".sr-only")).toHaveTextContent(/^0$/);
    await vi.waitFor(() => expect(value.querySelector("[aria-hidden]")).toHaveTextContent(/^0$/));
    expect(value).not.toHaveClass("is-empty");
    expect(screen.queryByText(/No data/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled(); // no extent lookup for a real value
  });
});
