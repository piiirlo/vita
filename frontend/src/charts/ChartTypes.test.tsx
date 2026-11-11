/** Part 11: every new chart type renders from a mocked chart-data response. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { EChartsOption } from "echarts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChartDataResult } from "../api.ts";
import ChartView from "./ChartView.tsx";
import { clearTimeExtentCache } from "./extentCache.ts";
import { adaptToViz, defaultQuery, type ChartState } from "./model.ts";
import { DATASET } from "./testData.ts";

const drawn: { label: string; option: EChartsOption }[] = [];
vi.mock("./EChart.tsx", () => ({
  default: ({ option, label }: { option: EChartsOption; label: string }) => {
    drawn.push({ label, option });
    return <div role="img" aria-label={label} />;
  },
}));

function result(columns: string[], rows: unknown[][], extra: Partial<ChartDataResult> = {}): ChartDataResult {
  return { columns: columns.map((name) => ({ name, type: "string", db_type: "text" })), rows, row_count: rows.length, truncated: false, duration_ms: 1, sql: "", ...extra };
}

function chart(viz: ChartState["vizType"], query: Partial<ChartState["query"]> = {}, display: ChartState["display"] = {}): ChartState {
  const s = adaptToViz({ vizType: "table", query: defaultQuery(DATASET), display: {} }, viz, DATASET);
  return { ...s, query: { ...s.query, ...query }, display: { ...s.display, ...display } };
}

const seriesTypes = () => ((drawn.at(-1)!.option.series as { type: string }[]) ?? []).map((s) => s.type);

describe("new chart types render from a mocked response", () => {
  afterEach(() => {
    drawn.length = 0;
    vi.unstubAllGlobals();
    clearTimeExtentCache();
  });

  it("area", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ column: "order_date", min: "2025-01-01", max: "2025-02-28" }))));
    const state = chart("area", { series: "channel" }, { stack: "stacked" });
    render(<ChartView state={state} result={result(["order_date", "channel", "count"], [["2025-01-01", "web", 3], ["2025-01-01", "store", 1]])} trend={null} dataset={DATASET} />);
    expect(screen.getByRole("img", { name: "Area chart of Count" })).toBeInTheDocument();
    expect(seriesTypes()).toEqual(["line", "line"]);
  });

  it("combo", () => {
    const state = chart("combo", { metrics: ["count", "revenue"], dimensions: ["status"], time: null });
    render(<ChartView state={state} result={result(["status", "count", "revenue"], [["paid", 3, 12]])} trend={null} dataset={DATASET} />);
    expect(screen.getByRole("img", { name: "Combo chart of Count, Revenue" })).toBeInTheDocument();
    expect(seriesTypes()).toEqual(["bar", "line"]);
  });

  it("treemap, with a hint when box sizes don't add up", () => {
    const state = chart("treemap", { dimensions: ["status", "channel"], metrics: [{ column: "line_total", aggregate: "AVG" }] });
    const rows = result(["status", "channel", "__other", "AVG(line_total)"], [["paid", "web", 0, 10], ["paid", "store", 0, 20]]);
    render(<ChartView state={state} result={rows} trend={null} dataset={DATASET} showHints />);
    expect(screen.getByRole("img", { name: "Treemap of Average line_total" })).toBeInTheDocument();
    expect(seriesTypes()).toEqual(["treemap"]);
    expect(screen.getByRole("note")).toHaveTextContent("Box sizes add up their parts");
  });

  it("funnel", () => {
    const state = chart("funnel", { dimensions: ["status"] });
    render(<ChartView state={state} result={result(["status", "count"], [["visit", 10], ["paid", 4]])} trend={null} dataset={DATASET} />);
    expect(screen.getByRole("img", { name: "Funnel of Count" })).toBeInTheDocument();
    expect(seriesTypes()).toEqual(["funnel"]);
  });

  it("gauge, with its target under it", () => {
    const state = chart("gauge", { metrics: ["revenue"] }, { gauge_target: 100 });
    render(<ChartView state={state} result={result(["revenue"], [[82]])} trend={null} dataset={DATASET} />);
    expect(screen.getByRole("img", { name: "Gauge: Revenue $82.00, Target $100.00 · 82% of target" })).toBeInTheDocument();
    expect(screen.getByTestId("gauge-target")).toHaveTextContent("Target $100.00 · 82% of target");
    expect(seriesTypes()).toEqual(["gauge", "gauge"]);
  });

  it("gauge with no rows in its time range: '-' and the hint, like a big number", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ column: "order_date", min: "2025-01-01", max: "2025-02-28" }))));
    const state = chart("gauge");
    render(<ChartView state={state} result={result(["count"], [], { range_start: "2030-01-01", range_end: "2030-01-31" })} trend={null} dataset={DATASET} />);
    expect(screen.getByTestId("big-number-value")).toHaveTextContent(/^-$/);
    expect(screen.getByRole("status")).toHaveTextContent("No data between Jan 1, 2030 and Jan 31, 2030.");
  });

  it("pivot table, whose groups collapse", () => {
    const state = chart("pivot_table", { dimensions: ["status", "channel"], column_dimensions: [], totals: true });
    const rows = result(["status", "channel", "__row_level", "__col_level", "count"], [
      ["open", "store", 2, 0, 2],
      ["open", "web", 2, 0, 3],
      ["open", null, 1, 0, 5],
      [null, null, 0, 0, 5],
    ]);
    render(<ChartView state={state} result={rows} trend={null} dataset={DATASET} />);
    const table = screen.getByRole("table");
    expect(within(table).getByRole("rowheader", { name: "Total" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "store" })).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: "Collapse open" }));
    expect(within(table).queryByRole("rowheader", { name: "store" })).not.toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "Expand open" })).toHaveAttribute("aria-expanded", "false");
  });

  it("pivot table warns when the row limit cut it off", () => {
    const state = chart("pivot_table", { dimensions: ["status"], totals: false });
    render(<ChartView state={state} result={result(["status", "__row_level", "__col_level", "count"], [["open", 1, 0, 2]], { truncated: true })} trend={null} dataset={DATASET} />);
    expect(screen.getByRole("note")).toHaveTextContent("The row limit was reached");
  });

  it("heatmap", () => {
    const state = chart("heatmap", { dimensions: ["status", "channel"] });
    render(<ChartView state={state} result={result(["status", "channel", "count"], [["paid", "web", 3]])} trend={null} dataset={DATASET} />);
    expect(screen.getByRole("img", { name: "Heatmap of Count" })).toBeInTheDocument();
    expect(seriesTypes()).toEqual(["heatmap"]);
  });

  it("scatter, with a notice when the points were capped", () => {
    const state = chart("scatter", { metrics: ["revenue", "count"], dimensions: ["status"] });
    const rows = result(["status", "revenue", "count"], [["paid", 10, 2], ["open", 5, 1]], { truncated: true });
    render(<ChartView state={state} result={rows} trend={null} dataset={DATASET} />);
    expect(screen.getByRole("img", { name: "Scatter plot of Count against Revenue" })).toBeInTheDocument();
    expect(seriesTypes()).toEqual(["scatter"]);
    expect(screen.getByRole("note")).toHaveTextContent("Showing the first 2 points");
  });

  it("histogram, saying how many rows had no value", () => {
    const state = chart("histogram", { bins: { column: "line_total", count: 2 } });
    const rows = result(["__bin", "__bin_start", "__bin_end", "count"], [[null, null, null, 3], [0, 0, 5, 1], [1, 5, 10, 2]]);
    render(<ChartView state={state} result={rows} trend={null} dataset={DATASET} />);
    expect(screen.getByRole("img", { name: "Histogram of line_total" })).toBeInTheDocument();
    expect(seriesTypes()).toEqual(["bar"]);
    expect(screen.getByRole("note")).toHaveTextContent("Rows without a value aren't in any bin (3).");
  });

  it("world map: loads the shapes lazily and lists the countries it couldn't match", async () => {
    const state = chart("world_map", { dimensions: ["status"] });
    const rows = result(["status", "count"], [["USA", 3], ["Russian Federation", 2], ["Narnia", 1]]);
    render(<ChartView state={state} result={rows} trend={null} dataset={DATASET} showHints />);
    expect(await screen.findByRole("img", { name: "World map of Count: 2 countries" }, { timeout: 5000 })).toBeInTheDocument();
    expect(seriesTypes()).toEqual(["map"]);
    expect(screen.getByTestId("map-unmatched")).toHaveTextContent("1 value couldn't be matched to a country: Narnia.");
  });
});
