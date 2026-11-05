import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { EChartsOption } from "echarts";
import { DATASET } from "../charts/testData.ts";
import ChartEditorPage from "./ChartEditorPage.tsx";

// ECharts needs a real canvas; capture the option instead.
const rendered: EChartsOption[] = [];
vi.mock("../charts/EChart.tsx", () => ({
  default: ({ option, label }: { option: EChartsOption; label: string }) => {
    rendered.push(option);
    return <div role="img" aria-label={label} />;
  },
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TABLE_RESULT = {
  columns: [
    { name: "status", type: "string", db_type: "text" },
    { name: "revenue", type: "number", db_type: "numeric" },
  ],
  rows: [
    ["completed", 1234.5],
    [null, 10],
  ],
  row_count: 2,
  truncated: false,
  duration_ms: 12,
  sql: 'SELECT "status", SUM(line_total) AS "revenue" FROM (…) AS "virtual_table" GROUP BY "status"',
};

const LINE_RESULT = {
  columns: [
    { name: "order_date", type: "date", db_type: "date" },
    { name: "revenue", type: "number", db_type: "numeric" },
  ],
  rows: [
    ["2025-01-01", 100],
    ["2025-02-01", 150],
  ],
  row_count: 2,
  truncated: false,
  duration_ms: 9,
  sql: "SELECT CAST(DATE_TRUNC('month', \"order_date\") AS DATE) …",
};

function mockApi() {
  const requests: { viz_type: string; query: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/datasets") return json([{ ...DATASET, columns: undefined }]);
      if (url === "/api/datasets/4") return json(DATASET);
      if (url === "/api/chart-data") {
        const body = JSON.parse(String(init?.body)) as { viz_type: string; query: Record<string, unknown> };
        requests.push(body);
        if (body.viz_type === "line") return json(LINE_RESULT);
        if (body.viz_type === "big_number") return json({ ...TABLE_RESULT, columns: [TABLE_RESULT.columns[1]], rows: [[4321]] });
        return json(TABLE_RESULT);
      }
      return json({ detail: `unexpected ${url}` }, 404);
    }),
  );
  return requests;
}

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={["/charts/new?dataset=4"]}>
      <Routes>
        <Route path="/charts/new" element={<ChartEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Chart editor", () => {
  it("loads with the dataset, chart type picker and a table of the default metric", async () => {
    mockApi();
    renderEditor();
    expect(await screen.findByLabelText("Dataset")).toHaveValue("4");
    expect(screen.getByRole("radio", { name: "Table" })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByRole("list", { name: "Metrics" })).getByText("Count")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update chart" })).toBeInTheDocument();
    // Auto-update ran the query and rendered the mocked response with labels and formats.
    expect(await screen.findByText("completed")).toBeInTheDocument();
    expect(screen.getByText("(empty)")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
  });

  it("shows the right controls for each chart type", async () => {
    mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");

    fireEvent.click(screen.getByRole("radio", { name: "Bar" }));
    expect(screen.getByLabelText("X axis")).toBeInTheDocument();
    expect(screen.getByLabelText("Series")).toBeInTheDocument();
    expect(screen.getByText("Stacked")).toBeInTheDocument();
    expect(screen.getByText("Horizontal")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Line" }));
    expect(screen.queryByLabelText("X axis")).not.toBeInTheDocument();
    expect(screen.getByText("Show points")).toBeInTheDocument();
    expect(screen.getByLabelText("Time grain")).toHaveValue("month");

    fireEvent.click(screen.getByRole("radio", { name: "Big number" }));
    expect(screen.getByText("Show trend line")).toBeInTheDocument();
    expect(screen.getByText("Subtitle")).toBeInTheDocument();
    expect(screen.queryByLabelText("Series")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Table" }));
    fireEvent.click(screen.getByRole("radio", { name: "Raw records" }));
    expect(screen.getByRole("list", { name: "Columns" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Metrics" })).not.toBeInTheDocument();
  });

  it("renders a line chart from a mocked response, and a big number with a trend", async () => {
    const requests = mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");

    fireEvent.click(screen.getByRole("radio", { name: "Line" }));
    fireEvent.change(screen.getByLabelText("Add a saved metric"), { target: { value: "revenue" } });
    expect(await screen.findByRole("img", { name: /Line chart of Count, Revenue/ })).toBeInTheDocument();
    await waitFor(() => {
      const option = rendered.at(-1)!;
      expect((option.xAxis as { data: string[] }).data).toEqual(["Jan 2025", "Feb 2025"]);
    });
    const lineRequest = requests.at(-1)!;
    expect(lineRequest.viz_type).toBe("line");
    expect(lineRequest.query).toMatchObject({ metrics: ["count", "revenue"], time: { grain: "month" } });

    fireEvent.click(screen.getByRole("radio", { name: "Big number" }));
    expect(await screen.findByTestId("big-number-value")).toHaveTextContent("4,321");
    await waitFor(() => expect(screen.getByRole("img", { name: "Trend" })).toBeInTheDocument());
    // Two requests: the total (no grain) and the trend (by month).
    const lastTwo = requests.slice(-2).map((r) => [r.viz_type, (r.query.time as { grain: string | null }).grain]);
    expect(lastTwo).toEqual([
      ["big_number", null],
      ["line", "month"],
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
    expect(screen.getByRole("button", { name: "Open in SQL Lab" })).toBeInTheDocument();
  });

  it("shows the error from a failing query", async () => {
    mockApi();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/datasets") return json([DATASET]);
      if (url === "/api/datasets/4") return json(DATASET);
      return json({ detail: { kind: "invalid", message: 'Unknown metric "nope".', line: null, column: null } }, 400);
    });
    renderEditor();
    expect(await screen.findByRole("alert")).toHaveTextContent('Unknown metric "nope".');
  });
});
