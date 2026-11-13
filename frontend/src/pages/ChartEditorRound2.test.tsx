/** Part 13 round 2: the chart editor's Data panel sections, dragging columns, custom SQL
 * metrics, conditional colors, big number position and saving to a dashboard. */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EChartsOption } from "echarts";
import { COLUMN_MIME } from "../charts/columnKinds.ts";
import { DATASET } from "../charts/testData.ts";
import Toaster from "../components/Toaster.tsx";
import { clearToasts } from "../components/toast.ts";
import ChartEditorPage from "./ChartEditorPage.tsx";

vi.mock("../charts/EChart.tsx", () => ({
  default: ({ label }: { option: EChartsOption; label: string }) => <div role="img" aria-label={label} />,
}));

afterEach(() => clearToasts());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function mockApi() {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ method, url, body });
      if (url === "/api/datasets") return json([{ ...DATASET, columns: undefined }]);
      if (url === "/api/datasets/4") return json(DATASET);
      if (url === "/api/datasets/4/metrics/validate") return json({ ok: true, error: null, warning: null, value: 12.5 });
      if (url === "/api/datasets/4/metrics" && method === "POST") return json({ id: 9, description: null, is_builtin: false, ...body }, 201);
      if (url.startsWith("/api/datasets/4/time-extent")) return json({ column: "order_date", min: "2025-01-01", max: "2026-10-10" });
      if (url === "/api/chart-data") {
        const { viz_type, query } = body as { viz_type: string; query: { metrics: unknown[] } };
        if (viz_type === "big_number") return json({ columns: [{ name: "count", type: "number", db_type: "int8" }], rows: [[4321]], row_count: 1, truncated: false, duration_ms: 3, sql: "SELECT" });
        const name = (m: unknown) => (typeof m === "string" ? m : ((m as { label?: string }).label ?? "m"));
        return json({
          columns: [{ name: "status", type: "string", db_type: "text" }, ...query.metrics.map((m) => ({ name: name(m), type: "number", db_type: "numeric" }))],
          rows: [["completed", ...query.metrics.map(() => 1234.5)], ["cancelled", ...query.metrics.map(() => -10)]],
          row_count: 2, truncated: false, duration_ms: 3, sql: "SELECT",
        });  // prettier-ignore
      }
      if (url === "/api/charts" && method === "POST") return json({ id: 12, dataset_id: 4, dataset_name: "order lines", created_at: "", updated_at: "", dashboards: [], ...body }, 201);
      if (url === "/api/charts/12") return json({ id: 12, name: "Revenue", description: null, dataset_id: 4, dataset_name: "order lines", viz_type: "table", params: { query: { dataset_id: 4, metrics: ["count"], dimensions: [], series: null, columns: [], time: null, filters: [], order_by: null, row_limit: 1000, series_limit: 10 }, display: {} }, created_at: "", updated_at: "", dashboards: [] });
      if (url === "/api/dashboards" && method === "GET") return json([{ id: 3, name: "Sales", description: null, tile_count: 2, updated_at: "" }]);
      if (url === "/api/dashboards" && method === "POST") return json({ id: 5, ...body }, 201);
      if (url === "/api/dashboards/3/charts") return json({ id: 3, name: "Sales", layout: [] });
      return json({ detail: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return calls;
}

function renderEditor(entry = "/charts/new?dataset=4") {
  const router = createMemoryRouter(
    [
      { path: "/charts/new", element: <ChartEditorPage /> },
      { path: "/charts/:id", element: <ChartEditorPage /> },
      { path: "/dashboards/:id", element: <p>A dashboard</p> },
    ],
    { initialEntries: [entry] },
  );
  render(
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>,
  );
  return router;
}

function pickChartType(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /^Chart type / }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Chart type" })).getByRole("radio", { name }));
}
function openSideTab(name: "Data" | "Customize") {
  fireEvent.mouseDown(within(screen.getByRole("tablist", { name: "Chart settings" })).getByRole("tab", { name }));
}
const section = (title: string) => screen.getByRole("heading", { name: title }).closest("section, details") as HTMLElement;
const lastChartQuery = (calls: Call[]) => (calls.filter((c) => c.url === "/api/chart-data").at(-1)!.body as { query: Record<string, unknown> }).query;

function drop(target: HTMLElement, column: string) {
  const dataTransfer = { types: [COLUMN_MIME, "text/plain"], getData: (type: string) => (type === COLUMN_MIME ? column : ""), dropEffect: "none" };
  fireEvent.dragOver(target, { dataTransfer });
  expect(target).toHaveClass("is-drop-target");
  fireEvent.drop(target, { dataTransfer });
}

describe("Data panel", () => {
  it("shows the sections a chart uses, in plain language; Sort & limit is folded", async () => {
    mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");
    pickChartType("Bar");
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Columns", "What to measure", "Break it down by", "Over time", "Filter", "Sort & limit"]));
    expect(section("Sort & limit")).not.toHaveAttribute("open");
    expect(within(section("Filter")).getByText("No filters: every row counts.")).toBeInTheDocument();
    pickChartType("Big number");
    expect(screen.queryByRole("heading", { name: "Break it down by" })).not.toBeInTheDocument();
  });

  it("takes columns dragged from the column list", async () => {
    const calls = mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");
    expect(within(screen.getByRole("list", { name: "Dataset columns" })).getByText("Status")).toBeInTheDocument();
    drop(section("What to measure"), "line_total");
    expect(within(screen.getByRole("list", { name: "Metrics" })).getByText("Sum of line_total")).toBeInTheDocument();
    drop(section("Break it down by"), "status");
    expect(within(screen.getByRole("list", { name: "Group by" })).getByText("Status")).toBeInTheDocument();
    // A column that can't go there says why.
    drop(section("Over time"), "status");
    expect(screen.getByText(/“Status” isn't a time column/)).toBeInTheDocument();
    await waitFor(() => expect(lastChartQuery(calls)).toMatchObject({ dimensions: ["status"], metrics: ["count", { column: "line_total", aggregate: "SUM" }] }));
  });

  it("searches the columns; each has an Add to… menu (the keyboard way)", async () => {
    mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");
    fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "chan" } });
    const list = screen.getByRole("list", { name: "Dataset columns" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.keyDown(within(list).getByRole("button", { name: "Add Channel to…" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Filter" }));
    expect(within(section("Filter")).getByLabelText("Filter column")).toHaveValue("channel");
  });
});

describe("Custom SQL metrics", () => {
  it("validate, run in the chart, and save to the dataset in one click", async () => {
    const calls = mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");
    const measure = section("What to measure");
    fireEvent.click(within(measure).getByRole("radio", { name: "Custom SQL" }));
    fireEvent.change(within(measure).getByLabelText("Custom metric label"), { target: { value: "Price per unit" } });
    const sql = within(measure).getByLabelText("Custom metric SQL");
    fireEvent.change(sql, { target: { value: "SUM(line", selectionStart: 8 } });
    // Autocomplete: the dataset's columns.
    const options = within(screen.getByRole("listbox", { name: "Columns and functions" })).getAllByRole("option");
    expect(options[0]).toHaveTextContent("line_total");
    fireEvent.keyDown(sql, { key: "Enter" });
    expect(sql).toHaveValue("SUM(line_total");
    fireEvent.change(sql, { target: { value: "SUM(line_total) / NULLIF(COUNT(*), 0)" } });
    fireEvent.click(within(measure).getByRole("button", { name: "Validate" }));
    expect(await within(measure).findByText("✓ Valid")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/datasets/4/metrics/validate")?.body).toEqual({ expression: "SUM(line_total) / NULLIF(COUNT(*), 0)" });
    fireEvent.click(within(measure).getByRole("button", { name: "Add" }));

    const chip = within(screen.getByRole("list", { name: "Metrics" })).getByText("Price per unit").closest("li")!;
    expect(within(chip).getByText("SQL")).toBeInTheDocument();
    await waitFor(() =>
      expect(lastChartQuery(calls).metrics).toEqual(["count", { sql: "SUM(line_total) / NULLIF(COUNT(*), 0)", label: "Price per unit" }]),
    );

    fireEvent.click(within(chip).getByRole("button", { name: "Save to dataset" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/api/datasets/4/metrics" && c.method === "POST")?.body).toEqual({
        name: "price_per_unit", label: "Price per unit", expression: "SUM(line_total) / NULLIF(COUNT(*), 0)", description: null, number_format: null,
      }),
    );  // prettier-ignore
    await waitFor(() => expect(lastChartQuery(calls).metrics).toEqual(["count", "price_per_unit"]));
    expect(within(screen.getByRole("list", { name: "Metrics" })).queryByText("SQL")).not.toBeInTheDocument();
  });
});

describe("Customize", () => {
  it("colors table cells by rules, with ▲ / ▼ (not color alone)", async () => {
    mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");
    drop(section("Break it down by"), "status");
    await screen.findByText("completed");
    openSideTab("Customize");
    const groups = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(["Labels & numbers", "Colors", "Layout"]);
    fireEvent.click(screen.getByRole("button", { name: "Positive / negative" }));
    expect(screen.getByRole("button", { name: "Positive / negative" })).toHaveAttribute("aria-pressed", "true");
    const positive = screen.getByText("1,234.5").closest("td")!;
    expect(positive).toHaveClass("cell-success");
    expect(positive).toHaveTextContent("▲ 1,234.5");
    expect(screen.getByText("-10").closest("td")).toHaveClass("cell-danger");
  });

  it("moves a big number (the subtitle and the rest follow)", async () => {
    mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");
    pickChartType("Big number");
    const value = await screen.findByTestId("big-number-value");
    const box = value.parentElement!;
    expect(box).toHaveClass("big-number-h-center", "big-number-v-middle");
    openSideTab("Customize");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Horizontal position" })).getByRole("radio", { name: "Left" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Vertical position" })).getByRole("radio", { name: "Top" }));
    expect(screen.getByTestId("big-number-value").parentElement).toHaveClass("big-number-h-left", "big-number-v-top");
  });
});

describe("Save to a dashboard", () => {
  it("saves a new chart and puts it on an existing dashboard", async () => {
    const calls = mockApi();
    const router = renderEditor();
    await screen.findByLabelText("Dataset");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Save chart" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Revenue" } });
    fireEvent.click(within(dialog).getByLabelText("Add to a dashboard"));
    fireEvent.click(await within(dialog).findByRole("radio", { name: "Sales" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/dashboards/3/charts")?.body).toEqual({ chart_id: 12 }));
    const order = calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(order.indexOf("/api/charts")).toBeLessThan(order.indexOf("/api/dashboards/3/charts"));
    expect(await screen.findByText('Saved "Revenue" and added it to Sales.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/dashboards/3"));
  });

  it("creates a new dashboard by name", async () => {
    const calls = mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Save chart" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Revenue" } });
    fireEvent.click(within(dialog).getByLabelText("Add to a dashboard"));
    fireEvent.change(await within(dialog).findByLabelText("Find or name a dashboard"), { target: { value: "Ops" } });
    expect(within(dialog).queryByRole("radio", { name: "Sales" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("radio", { name: "New dashboard “Ops”" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/dashboards" && c.method === "POST")).toBeDefined());
    const created = calls.find((c) => c.url === "/api/dashboards" && c.method === "POST")!.body!;
    expect(created).toMatchObject({ name: "Ops", layout: [{ type: "chart", chart_id: 12, x: 0, y: 0 }] });
  });

  it("asks for a dashboard when one must be picked", async () => {
    mockApi();
    renderEditor();
    await screen.findByLabelText("Dataset");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Save chart" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Revenue" } });
    fireEvent.click(within(dialog).getByLabelText("Add to a dashboard"));
    await within(dialog).findByRole("radio", { name: "Sales" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Pick a dashboard, or type a name for a new one.")).toBeInTheDocument();
  });
});
