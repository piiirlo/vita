import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { EChartsOption } from "echarts";
import type { Dataset } from "../api.ts";
import { DATASET } from "../charts/testData.ts";
import { adaptToViz, defaultQuery, toParams } from "../charts/model.ts";
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

const dataset = DATASET;
const SAVED_CHART = {
  id: 7,
  name: "Revenue by status",
  description: null,
  dataset_id: 4,
  dataset_name: "orders",
  viz_type: "table",
  params: toParams(adaptToViz({ vizType: "table", query: defaultQuery(dataset), display: {} }, "table", dataset)),
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/** A saved chart whose time range (last 30 days) has no data. */
const RANGED_CHART = {
  ...SAVED_CHART,
  id: 9,
  name: "Recent orders",
  params: {
    ...SAVED_CHART.params,
    query: { ...SAVED_CHART.params.query, time: { column: "order_date", grain: null, range: { kind: "last_30_days" } } },
  },
};

/** A bar chart by status (one series), and a big number over the last 30 days. */
const BAR_CHART = {
  ...SAVED_CHART,
  id: 10,
  name: "Revenue by status",
  viz_type: "bar",
  params: { query: { ...SAVED_CHART.params.query, metrics: ["revenue"], dimensions: ["status"], series: null, time: null }, display: {} },
};
const BIG_CHART = {
  ...SAVED_CHART,
  id: 11,
  name: "Revenue, last 30 days",
  viz_type: "big_number",
  params: {
    query: { ...SAVED_CHART.params.query, metrics: ["revenue"], time: { column: "order_date", grain: null, range: { kind: "last_30_days" } } },
    display: {},
  },
};

/** Saves (PUT / POST of /api/charts) seen by the mock. */
const saves: { method: string; url: string; body: Record<string, unknown> }[] = [];

function mockApi(ds: Dataset = DATASET) {
  const requests: { viz_type: string; query: Record<string, unknown> }[] = [];
  saves.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/datasets") return json([{ ...ds, columns: undefined }]);
      if (url === "/api/datasets/4") return json(ds);
      if (url === "/api/charts/7" && method === "GET") return json(SAVED_CHART);
      if ((url === "/api/charts/7" && method === "PUT") || (url === "/api/charts" && method === "POST")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        saves.push({ method, url, body });
        return json({ ...SAVED_CHART, ...body, id: method === "POST" ? 8 : 7 }, method === "POST" ? 201 : 200);
      }
      if (url === "/api/charts/8") return json({ ...SAVED_CHART, id: 8, name: "Brand new" });
      if (url === "/api/charts/9") return json(RANGED_CHART);
      if (url === "/api/charts/10") return json(BAR_CHART);
      if (url === "/api/charts/11") return json(BIG_CHART);
      if (url === "/api/datasets/4/time-extent?column=order_date") return json({ column: "order_date", min: "2024-01-02", max: "2025-12-30" });
      if (url === "/api/chart-data") {
        const body = JSON.parse(String(init?.body)) as { viz_type: string; query: Record<string, unknown> };
        requests.push(body);
        const range = (body.query.time as { range?: { kind: string } } | null | undefined)?.range;
        if (body.viz_type === "big_number" && range && range.kind !== "none") {
          // The comparison asks for a custom range (the period before).
          const before = range.kind === "custom";
          return json({
            ...TABLE_RESULT,
            columns: [TABLE_RESULT.columns[1]],
            rows: [[before ? 4000 : 4400]],
            range_start: before ? "2026-09-10" : "2026-10-11",
            range_end: before ? "2026-10-10" : "2026-11-10",
          });
        }
        if (range && range.kind !== "none")
          return json({ ...TABLE_RESULT, rows: [], row_count: 0, range_start: "2026-10-10", range_end: "2026-11-09" });
        if (body.viz_type === "pie") {
          const rows = Array.from({ length: 8 }, (_, i) => [`status ${i}`, 0, 100 - i]);
          return json({
            ...TABLE_RESULT,
            columns: [TABLE_RESULT.columns[0], { name: "__other", type: "number", db_type: "int4" }, { name: "count", type: "number", db_type: "int8" }],
            rows: [...rows, [null, 1, 50]],
            row_count: 9,
          });
        }
        if (body.viz_type === "line") return json(LINE_RESULT);
        if (body.viz_type === "big_number") return json({ ...TABLE_RESULT, columns: [TABLE_RESULT.columns[1]], rows: [[4321]] });
        return json(TABLE_RESULT);
      }
      return json({ detail: `unexpected ${url}` }, 404);
    }),
  );
  return requests;
}

// A data router: the editor uses useBlocker for its unsaved-changes warning.
function renderEditor(entry = "/charts/new?dataset=4") {
  const router = createMemoryRouter(
    [
      { path: "/charts/new", element: <ChartEditorPage /> },
      { path: "/charts/:id", element: <ChartEditorPage /> },
      { path: "/charts", element: <p>Charts list</p> },
      { path: "/dashboards", element: <p>Dashboards list</p> },
    ],
    { initialEntries: ["/dashboards", entry], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** The side panel's Data / Customize tabs (Radix tabs switch on mouse down). */
function openSideTab(name: "Data" | "Customize") {
  fireEvent.mouseDown(within(screen.getByRole("tablist", { name: "Chart settings" })).getByRole("tab", { name }));
}

/** The chart type gallery: open it and pick a type. */
function pickChartType(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /^Chart type / }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Chart type" })).getByRole("radio", { name }));
}

describe("Chart editor", () => {
  it("loads with the dataset, chart type picker and a table of the default metric", async () => {
    mockApi();
    renderEditor();
    expect(await screen.findByLabelText("Dataset")).toHaveValue("4");
    expect(screen.getByRole("button", { name: "Chart type Table" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Chart type / }));
    expect(within(screen.getByRole("dialog", { name: "Chart type" })).getByRole("radio", { name: "Table" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Chart type" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Chart type" })).not.toBeInTheDocument());
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

    // Data controls are on the Data tab; the look (Stacked, Horizontal, ...) on Customize.
    pickChartType("Bar");
    expect(screen.getByLabelText("X axis")).toBeInTheDocument();
    expect(screen.getByLabelText("Series")).toBeInTheDocument();
    openSideTab("Customize");
    expect(screen.getByText("Stacked")).toBeInTheDocument();
    expect(screen.getByText("Horizontal")).toBeInTheDocument();
    openSideTab("Data");

    pickChartType("Line");
    // Line charts: time on the x axis by default (a dimension is possible too).
    expect(screen.getByLabelText("X axis")).toHaveValue("__time__");
    expect(screen.getByLabelText("Time grain")).toHaveValue("month");
    openSideTab("Customize");
    expect(screen.getByText("Show points")).toBeInTheDocument();
    openSideTab("Data");

    pickChartType("Big number");
    expect(screen.queryByLabelText("Series")).not.toBeInTheDocument();
    openSideTab("Customize");
    expect(screen.getByText("Show trend line")).toBeInTheDocument();
    expect(screen.getByText("Subtitle")).toBeInTheDocument();
    openSideTab("Data");

    pickChartType("Table");
    fireEvent.click(screen.getByRole("radio", { name: "Raw records" }));
    expect(screen.getByRole("list", { name: "Columns" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Metrics" })).not.toBeInTheDocument();
  });

  it("renders a line chart from a mocked response, and a big number with a trend", async () => {
    const requests = mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");

    pickChartType("Line");
    fireEvent.change(screen.getByLabelText("Add a saved metric"), { target: { value: "revenue" } });
    expect(await screen.findByRole("img", { name: /Line chart of Count, Revenue/ })).toBeInTheDocument();
    await waitFor(() => {
      const option = rendered.at(-1)!;
      expect((option.xAxis as { data: string[] }).data).toEqual(["Jan 2025", "Feb 2025"]);
    });
    const lineRequest = requests.at(-1)!;
    expect(lineRequest.viz_type).toBe("line");
    expect(lineRequest.query).toMatchObject({ metrics: ["count", "revenue"], time: { grain: "month" } });

    pickChartType("Big number");
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

  describe("unsaved changes", () => {
    it("lets an untouched new chart leave freely", async () => {
      mockApi();
      const router = renderEditor();
      await screen.findByText("completed");
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("link", { name: "Charts" }));
      expect(await screen.findByText("Charts list")).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/charts");
    });

    it("asks Save / Discard / Stay before leaving; Stay keeps the changes, Discard leaves", async () => {
      mockApi();
      const router = renderEditor("/charts/7");
      fireEvent.change(await screen.findByLabelText("Chart name"), { target: { value: "Renamed" } });
      expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("link", { name: "Charts" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Discard" })).toBeInTheDocument();
      // Stay has focus, so Enter never throws work away.
      expect(within(dialog).getByRole("button", { name: "Stay" })).toHaveFocus();
      fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(router.state.location.pathname).toBe("/charts/7");
      expect(screen.getByLabelText("Chart name")).toHaveValue("Renamed");

      // Browser back, the rail and the command palette navigate through the router too.
      void router.navigate(-1);
      fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
      expect(await screen.findByText("Dashboards list")).toBeInTheDocument();
      expect(saves).toHaveLength(0);
    });

    it("Save saves the chart, then leaves", async () => {
      mockApi();
      const router = renderEditor("/charts/7");
      fireEvent.change(await screen.findByLabelText("Chart name"), { target: { value: "Renamed" } });
      void router.navigate("/dashboards");
      fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save" }));
      expect(await screen.findByText("Dashboards list")).toBeInTheDocument();
      expect(saves).toMatchObject([{ method: "PUT", url: "/api/charts/7", body: { name: "Renamed" } }]);
    });

    it("Save on a new chart asks for a name first, then leaves (Cancel stays)", async () => {
      mockApi();
      const router = renderEditor();
      await screen.findByText("completed");
      pickChartType("Bar");
      expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();

      // Cancel in the name dialog: stay on the editor.
      fireEvent.click(screen.getByRole("link", { name: "Charts" }));
      fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/charts/new");

      // Name it and save: the chart is created and the navigation goes on.
      fireEvent.click(screen.getByRole("link", { name: "Charts" }));
      fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save" }));
      fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Brand new" } });
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
      expect(await screen.findByText("Charts list")).toBeInTheDocument();
      expect(saves).toMatchObject([{ method: "POST", url: "/api/charts", body: { name: "Brand new", viz_type: "bar" } }]);
    });

    it("saving with the Save button never triggers the warning", async () => {
      mockApi();
      const router = renderEditor("/charts/7");
      fireEvent.change(await screen.findByLabelText("Chart name"), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(saves).toHaveLength(1));
      await waitFor(() => expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole("link", { name: "Charts" }));
      expect(await screen.findByText("Charts list")).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/charts");
    });

    it("asks the browser to confirm closing the tab only while there are unsaved changes", async () => {
      mockApi();
      renderEditor("/charts/7");
      const input = await screen.findByLabelText("Chart name");
      const clean = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(clean);
      expect(clean.defaultPrevented).toBe(false);
      fireEvent.change(input, { target: { value: "Renamed" } });
      const dirty = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(dirty);
      expect(dirty.defaultPrevented).toBe(true);
    });
  });

  it("an empty time range says where the data is, and 'Show all time' clears the range", async () => {
    const requests = mockApi();
    renderEditor("/charts/9");
    const empty = await screen.findByText(/No data between Oct 10, 2026 and Nov 9, 2026\./);
    expect(empty).toBeInTheDocument();
    expect(await screen.findByTestId("time-extent")).toHaveTextContent("This dataset has data from Jan 2, 2024 to Dec 30, 2025.");
    expect(requests.at(-1)!.query.time).toMatchObject({ range: { kind: "last_30_days" } });

    fireEvent.click(screen.getByRole("button", { name: "Show all time" }));
    expect(await screen.findByText("completed")).toBeInTheDocument();
    expect(requests.at(-1)!.query.time).toMatchObject({ column: "order_date", range: { kind: "none" } });
    // Clearing the range is a real change to the chart.
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("keeps edits when the datasets list arrives after the chart (no reload)", async () => {
    mockApi();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let releaseList: () => void = () => undefined;
    const listHeld = new Promise<void>((r) => (releaseList = r));
    let chartLoads = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/datasets") await listHeld;
      if (url === "/api/charts/7" && (init?.method ?? "GET") === "GET") chartLoads++;
      return original(input, init);
    });
    renderEditor("/charts/7");
    await waitFor(() => expect(chartLoads).toBe(1));
    await new Promise((r) => setTimeout(r, 50)); // the chart and its dataset have loaded
    releaseList();
    // The editor shows up once the list is there; edit right away.
    fireEvent.change(await screen.findByLabelText("Chart name"), { target: { value: "Renamed" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText("Chart name")).toHaveValue("Renamed");
    expect(chartLoads).toBe(1);
  });

  describe("Customize", () => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const checkbox = (name: string) => screen.getByRole("checkbox", { name });

    it("applies look options at once from the loaded data, without a new query", async () => {
      const requests = mockApi();
      renderEditor("/charts/10");
      expect(await screen.findByRole("img", { name: /Bar chart of Revenue/ })).toBeInTheDocument();
      const before = requests.length;
      openSideTab("Customize");

      fireEvent.click(checkbox("Horizontal"));
      await waitFor(() => expect((rendered.at(-1)!.yAxis as { type: string }).type).toBe("category"));

      fireEvent.change(screen.getByLabelText("Format of Revenue"), { target: { value: "compact" } });
      await waitFor(() => {
        const axis = rendered.at(-1)!.xAxis as { axisLabel: { formatter(v: number): string } };
        expect(axis.axisLabel.formatter(1234.5)).toBe("1.2K");
      });
      expect(screen.getByTestId("format-example")).toHaveTextContent("67.4K");

      fireEvent.change(screen.getByLabelText("Name for Revenue"), { target: { value: "Sales" } });
      await waitFor(() => expect((rendered.at(-1)!.series as { name: string }[])[0]!.name).toBe("Sales"));

      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Sales by status" } });
      expect(screen.getByRole("heading", { name: "Sales by status" })).toBeInTheDocument();

      // Longer than the auto-update delay: still no new database query.
      await pause(900);
      expect(requests.length).toBe(before);
      expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();

      // "Update chart" still re-runs on demand.
      fireEvent.click(screen.getByRole("button", { name: "Update chart" }));
      await waitFor(() => expect(requests.length).toBe(before + 1));
    });

    it("disables options that don't apply, with a hint", async () => {
      mockApi();
      renderEditor("/charts/10");
      await screen.findByRole("img", { name: /Bar chart/ });
      openSideTab("Customize");
      const stacked = checkbox("Stacked");
      expect(stacked).toBeDisabled();
      expect(stacked).toHaveAccessibleDescription("Add a series to stack bars");
      expect(screen.getByRole("radio", { name: "Single color" })).toBeEnabled();
      expect(screen.getByLabelText("Legend")).toBeDisabled();

      // With a series, stacking works and one color doesn't.
      openSideTab("Data");
      fireEvent.change(screen.getByLabelText("Series"), { target: { value: "channel" } });
      openSideTab("Customize");
      expect(checkbox("Stacked")).toBeEnabled();
      expect(screen.getByRole("radio", { name: "Single color" })).toBeDisabled();
      expect(screen.getByRole("radio", { name: "Single color" })).toHaveAccessibleDescription(/single series/);
    });

    it("compares a big number with the previous period (one more query)", async () => {
      const requests = mockApi();
      renderEditor("/charts/11");
      expect(await screen.findByTestId("big-number-value")).toBeInTheDocument();
      openSideTab("Customize");
      fireEvent.click(checkbox("Compare with the previous period"));
      const change = await screen.findByTestId("big-number-change");
      expect(change).toHaveTextContent("+10.0%");
      expect(change).toHaveTextContent("vs previous period ($4,000.00)");
      expect(change).toHaveAttribute("title", expect.stringContaining("Sep 10, 2026 – Oct 10, 2026"));
      expect(requests.at(-1)!.query.time).toMatchObject({ range: { kind: "custom", start: "2026-09-10", end: "2026-10-10" } });

      // Conditional color (a rule: below 5,000 in red): color + arrow + words.
      fireEvent.click(screen.getByRole("button", { name: "+ Add rule" }));
      expect(screen.getByLabelText("Rule 1: when the value is")).toHaveValue("below");
      expect(screen.getByLabelText("Rule 1: color")).toHaveValue("danger");
      fireEvent.change(screen.getByLabelText("Rule 1: threshold"), { target: { value: "5000" } });
      expect(await screen.findByTestId("big-number-status")).toHaveTextContent("Below $5,000.00");
      expect(screen.getByTestId("big-number-value")).toHaveClass("is-below");
    });
  });

  it("uses the chart's cache setting; Update chart skips the cache", async () => {
    const requests = mockApi() as unknown as { refresh?: boolean; cache_ttl?: number; viz_type: string }[];
    renderEditor("/charts/10");
    await screen.findByRole("img", { name: /Bar chart/ });
    expect(requests.at(-1)).not.toHaveProperty("refresh");
    expect(requests.at(-1)).not.toHaveProperty("cache_ttl");

    fireEvent.change(screen.getByLabelText("Cache results"), { target: { value: "0" } });
    // A cache setting doesn't need a new query by itself...
    await new Promise((r) => setTimeout(r, 900));
    const count = requests.length;
    // ...but the next run sends it, and Update chart asks for fresh data.
    fireEvent.click(screen.getByRole("button", { name: "Update chart" }));
    await waitFor(() => expect(requests.length).toBe(count + 1));
    expect(requests.at(-1)).toMatchObject({ refresh: true, cache_ttl: 0 });
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("makes a pie with top slices and warns gently about too many slices", async () => {
    const requests = mockApi();
    renderEditor();
    await screen.findByText("completed");
    pickChartType("Pie / donut");
    expect(await screen.findByRole("img", { name: /Pie chart of Count/ })).toBeInTheDocument();
    expect(requests.at(-1)).toMatchObject({ viz_type: "pie", query: { series_limit: 6, series: null } });
    expect(screen.getByLabelText("Slices")).toHaveValue("status");
    expect(screen.queryByLabelText("Time grain")).not.toBeInTheDocument();
    // 9 slices (8 + Other): more than 7.
    expect(await screen.findByTestId("pie-warning")).toHaveTextContent("9 slices");

    openSideTab("Customize");
    expect(screen.getByRole("radio", { name: "Single color" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Axis titles" })).toBeDisabled();
    const before = requests.length;
    fireEvent.click(screen.getByRole("checkbox", { name: "Donut (total in the middle)" }));
    // The donut asks for the total too.
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(before + 2));
    expect(requests.slice(before).map((r) => r.viz_type).sort()).toEqual(["big_number", "pie"]);
    expect(await screen.findByRole("img", { name: /Donut chart of Count/ })).toBeInTheDocument();
  });

  describe("chart type gallery", () => {
    it("groups the types, searches them, and Enter picks the first match", async () => {
      mockApi();
      renderEditor();
      await screen.findByLabelText("Dataset");
      fireEvent.click(screen.getByRole("button", { name: /^Chart type / }));
      const dialog = screen.getByRole("dialog", { name: "Chart type" });
      for (const group of ["Trends", "Compare", "Part of whole", "Single value", "Tables", "Distribution", "Geo"]) {
        expect(within(dialog).getByRole("region", { name: group })).toBeInTheDocument();
      }
      expect(within(dialog).getAllByRole("radio")).toHaveLength(15);
      fireEvent.change(within(dialog).getByLabelText("Search chart types"), { target: { value: "kpi" } });
      expect(within(dialog).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["Big number", "Gauge"]);
      fireEvent.keyDown(within(dialog).getByLabelText("Search chart types"), { key: "Enter" });
      expect(await screen.findByRole("button", { name: "Chart type Big number" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Chart type" })).not.toBeInTheDocument();
    });

    it("says what didn't carry over when switching, and what still needs picking", async () => {
      mockApi();
      renderEditor();
      await screen.findByLabelText("Dataset");
      fireEvent.change(screen.getByLabelText("Add a saved metric"), { target: { value: "revenue" } });
      pickChartType("Funnel");
      const note = screen.getByRole("status", { name: "" });
      expect(note).toHaveTextContent("Kept: dataset, Count.");
      expect(note).toHaveTextContent("Not used: Revenue (a funnel uses one metric).");
      fireEvent.click(within(note).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText(/Not used:/)).not.toBeInTheDocument();
    });

    it("pivot table: at most 3 row and 2 column dimensions, with a hint", async () => {
      const extra = ["region", "segment", "city"].map((name, i) => ({ ...DATASET.columns[1]!, id: 90 + i, name, label: null }));
      const requests = mockApi({ ...DATASET, columns: [...DATASET.columns, ...extra] });
      renderEditor();
      await screen.findByLabelText("Dataset");
      pickChartType("Pivot table");
      fireEvent.change(screen.getByLabelText("Add to Rows"), { target: { value: "region" } });
      expect(screen.getByLabelText("Add to Rows")).toBeEnabled();
      fireEvent.change(screen.getByLabelText("Add to Rows"), { target: { value: "segment" } });
      expect(screen.getByLabelText("Add to Rows")).toBeDisabled();
      expect(screen.getByLabelText("Add to Rows")).toHaveAccessibleDescription(/at most 3 row dimensions/);
      fireEvent.change(screen.getByLabelText("Add to Columns"), { target: { value: "channel" } });
      fireEvent.change(screen.getByLabelText("Add to Columns"), { target: { value: "order_date" } });
      expect(screen.getByLabelText("Add to Columns")).toBeDisabled();
      expect(screen.getByLabelText("Add to Columns")).toHaveAccessibleDescription(/at most 2 column dimensions/);
      fireEvent.click(screen.getByRole("button", { name: "Update chart" }));
      await waitFor(() => expect(requests.at(-1)?.viz_type).toBe("pivot_table"));
      expect(requests.at(-1)!.query).toMatchObject({ dimensions: ["status", "region", "segment"], column_dimensions: ["channel", "order_date"], totals: true });
    });

    it("pivot rows and columns can be date buckets (month, quarter, year)", async () => {
      const requests = mockApi();
      renderEditor();
      await screen.findByLabelText("Dataset");
      pickChartType("Pivot table");
      const add = screen.getByLabelText("Add to Columns");
      expect(within(add).getByRole("option", { name: "order_date · by quarter" })).toBeInTheDocument();
      fireEvent.change(add, { target: { value: "order_date@month" } });
      expect(within(screen.getByRole("list", { name: "Columns" })).getByText("order_date · by month")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Update chart" }));
      await waitFor(() => expect(requests.at(-1)?.viz_type).toBe("pivot_table"));
      expect(requests.at(-1)!.query).toMatchObject({ column_dimensions: ["order_date@month"] });
    });

    it("histogram: a number column in bins, by number or by width", async () => {
      const requests = mockApi();
      renderEditor();
      await screen.findByLabelText("Dataset");
      pickChartType("Histogram");
      expect(screen.getByLabelText("Number column")).toHaveValue("line_total");
      expect(screen.getByLabelText("Number of bins")).toHaveValue(20);
      fireEvent.click(screen.getByRole("radio", { name: "Bin width" }));
      fireEvent.change(screen.getByLabelText("Bin width"), { target: { value: "25" } });
      fireEvent.click(screen.getByRole("button", { name: "Update chart" }));
      await waitFor(() => expect(requests.at(-1)?.viz_type).toBe("histogram"));
      expect(requests.at(-1)!.query).toMatchObject({ bins: { column: "line_total", width: 25 }, dimensions: [], metrics: ["count"] });
    });
  });
});

describe("Chart editor: Part 13", () => {
  it("doesn't offer identifiers for sum or average", async () => {
    const extra = [{ ...DATASET.columns[3]!, id: 70, name: "row_id", label: "Row ID", is_identifier: true }];
    mockApi({ ...DATASET, columns: [...DATASET.columns, ...extra] });
    renderEditor();
    await screen.findByLabelText("Dataset");
    const columnOptions = () => within(screen.getByLabelText("Metric column")).getAllByRole("option").map((o) => o.textContent);
    expect(columnOptions()).not.toContain("Row ID");
    fireEvent.change(screen.getByLabelText("Aggregate"), { target: { value: "COUNT_DISTINCT" } });
    expect(columnOptions()).toContain("Row ID");
  });

  it("checks the time column before running: a year number has no months", async () => {
    const year = { ...DATASET.columns[3]!, id: 71, name: "year", label: "Year", is_temporal: true, time_kind: "year_number" as const };
    const requests = mockApi({ ...DATASET, main_time_column: "year", columns: [year, ...DATASET.columns.slice(1)] });
    renderEditor();
    await screen.findByLabelText("Dataset");
    pickChartType("Line");
    const grain = screen.getByLabelText("Time grain");
    expect(grain).toHaveValue("year");
    expect(within(grain).getByRole("option", { name: /^Month/ })).toBeDisabled();
    expect(screen.getByText(/This column only has years/)).toBeInTheDocument();
    // No "raw values" for a year number: it is the same as years.
    expect(within(grain).queryByRole("option", { name: "None (raw values)" })).not.toBeInTheDocument();
    // The chart runs by year; a month grain would be stopped before any query.
    await waitFor(() =>
      expect(requests.some((r) => r.viz_type === "line" && (r.query.time as { grain: string }).grain === "year")).toBe(true),
    );
    expect(requests.some((r) => (r.query.time as { grain?: string } | null)?.grain === "month")).toBe(false);
  });

  it("offers raw values and a dimension on the x axis of a line chart", async () => {
    mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");
    pickChartType("Line");
    expect(within(screen.getByLabelText("Time grain")).getByRole("option", { name: "None (raw values)" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("X axis"), { target: { value: "status" } });
    expect(screen.queryByLabelText("Time grain")).not.toBeInTheDocument();
    expect(screen.getByLabelText("X axis")).toHaveValue("status");
  });
});
