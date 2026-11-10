import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Dashboard, DashboardTile, SavedChart, VizType } from "../api.ts";
import { defaultQuery } from "../charts/model.ts";
import { DATASET } from "../charts/testData.ts";
import type { GridItem } from "../dashboards/layout.ts";
import DashboardPage from "./DashboardPage.tsx";
import { readSource } from "../test/readSource.ts";

// ECharts needs a real canvas.
vi.mock("../charts/EChart.tsx", () => ({
  default: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}));

// react-grid-layout needs real layout; a stub renders the tiles and can fake a resize.
vi.mock("../dashboards/DashboardGrid.tsx", () => ({
  default: ({
    items,
    editing,
    onLayoutChange,
    children,
  }: {
    items: GridItem[];
    editing: boolean;
    onLayoutChange(items: GridItem[]): void;
    children: ReactNode;
  }) => (
    <div data-testid="grid" data-editing={String(editing)}>
      {children}
      {editing && (
        <button onClick={() => onLayoutChange(items.map((i) => (i.i === "c1" ? { ...i, w: 12, h: 4 } : i)))}>
          Simulate resize
        </button>
      )}
    </div>
  ),
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const LAYOUT: DashboardTile[] = [
  { id: "t1", type: "text", text: "# Q4 numbers", x: 0, y: 0, w: 12, h: 2 },
  { id: "c1", type: "chart", chart_id: 10, x: 0, y: 2, w: 4, h: 6 },
  { id: "c2", type: "chart", chart_id: 11, x: 4, y: 2, w: 8, h: 6 },
  { id: "c3", type: "chart", chart_id: 12, x: 0, y: 8, w: 12, h: 8 },
];

const CHARTS: Record<number, { name: string; viz: VizType }> = {
  10: { name: "Total revenue", viz: "big_number" },
  11: { name: "Broken bars", viz: "bar" },
  12: { name: "Orders by status", viz: "table" },
};

const DASHBOARD: Dashboard = {
  id: 1,
  name: "Sales overview",
  description: null,
  layout: LAYOUT,
  cache_ttl: null,
  refresh_interval: "off",
  charts: Object.fromEntries(Object.entries(CHARTS).map(([id, c]) => [id, { id: Number(id), name: c.name, viz_type: c.viz }])),
  created_at: "2026-11-05T10:00:00Z",
  updated_at: "2026-11-05T10:00:00Z",
};

function savedChart(id: number): SavedChart {
  const { name, viz } = CHARTS[id]!;
  const query = { ...defaultQuery(DATASET), metrics: ["revenue"], dimensions: viz === "table" ? ["status"] : [] };
  if (viz === "bar") query.dimensions = ["status"];
  return {
    id,
    name,
    description: null,
    dataset_id: 4,
    dataset_name: DATASET.name,
    viz_type: viz,
    params: { query, display: {} },
    created_at: DASHBOARD.created_at,
    updated_at: DASHBOARD.updated_at,
  };
}

const column = (name: string, type: string) => ({ name, type, db_type: type });

function mockApi() {
  const puts: Dashboard[] = [];
  const chartData: string[] = [];
  // Full chart-data request bodies (cache options).
  const bodies: { viz_type: string; cache_ttl?: number; refresh?: boolean }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/dashboards/1" && method === "GET") return json(DASHBOARD);
      if (url === "/api/dashboards/1" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Dashboard;
        puts.push(body);
        return json({ ...DASHBOARD, ...body });
      }
      const chartMatch = /^\/api\/charts\/(\d+)$/.exec(url);
      if (chartMatch) return json(savedChart(Number(chartMatch[1])));
      if (url === "/api/datasets/4") return json(DATASET);
      if (url === "/api/chart-data") {
        const body = JSON.parse(String(init?.body)) as { viz_type: string; cache_ttl?: number; refresh?: boolean };
        chartData.push(body.viz_type);
        bodies.push(body);
        if (body.viz_type === "bar") {
          return json({ detail: { kind: "database", message: 'column "nope" does not exist', line: null, column: null } }, 400);
        }
        if (body.viz_type === "big_number") {
          return json({ columns: [column("revenue", "number")], rows: [[4321]], row_count: 1, truncated: false, duration_ms: 3, sql: "SELECT SUM(…)" });
        }
        return json({
          columns: [column("status", "string"), column("revenue", "number")],
          rows: [["completed", 1234.5]],
          row_count: 1,
          truncated: false,
          duration_ms: 3,
          sql: "SELECT status …",
          // The table tile comes from the cache unless asked to refresh.
          cached_at: body.refresh ? null : new Date(Date.now() - 5 * 60_000).toISOString(),
        });
      }
      return json({ detail: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return { puts, chartData, bodies };
}

function renderDashboard() {
  const router = createMemoryRouter(
    [
      { path: "/dashboards/:id", element: <DashboardPage /> },
      { path: "/dashboards", element: <p>Dashboards list</p> },
    ],
    { initialEntries: ["/dashboards/1"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("Dashboard page", () => {
  it("loads in view mode with text and charts", async () => {
    const { chartData } = mockApi();
    renderDashboard();
    expect(await screen.findByRole("heading", { level: 1, name: "Sales overview" })).toBeInTheDocument();
    // The text tile is rendered markdown.
    expect(within(screen.getByTestId("tile-t1")).getByRole("heading", { name: "Q4 numbers" })).toBeInTheDocument();
    expect(screen.getByTestId("grid")).toHaveAttribute("data-editing", "false");
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh all" })).toBeInTheDocument();
    expect(screen.getByText(/Last updated/)).toBeInTheDocument();

    expect(await within(screen.getByTestId("tile-c1")).findByTestId("big-number-value")).toHaveTextContent("$4,321.00");
    expect(await within(screen.getByTestId("tile-c3")).findByText("completed")).toBeInTheDocument();
    expect(within(screen.getByTestId("tile-c1")).getByText("Total revenue")).toBeInTheDocument();
    expect(chartData.sort()).toEqual(["bar", "big_number", "table"]);
  });

  it("shows an error in a failing tile while the other tiles render", async () => {
    mockApi();
    renderDashboard();
    const broken = await screen.findByTestId("tile-c2");
    expect(await within(broken).findByRole("alert")).toHaveTextContent('column "nope" does not exist');
    expect(within(broken).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(await within(screen.getByTestId("tile-c1")).findByTestId("big-number-value")).toBeInTheDocument();
    expect(await within(screen.getByTestId("tile-c3")).findByText("completed")).toBeInTheDocument();
    expect(within(screen.getByTestId("tile-c1")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("edit mode saves a changed layout, and cancel restores the saved one", async () => {
    const { puts } = mockApi();
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("grid")).toHaveAttribute("data-editing", "true");

    // Cancel throws away changes.
    fireEvent.click(screen.getByRole("button", { name: "Remove Broken bars" }));
    expect(screen.queryByTestId("tile-c2")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByTestId("tile-c2")).toBeInTheDocument();
    expect(puts).toHaveLength(0);

    // Resize a tile, edit the text, and save.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Simulate resize" }));
    fireEvent.change(screen.getByLabelText("Text (Markdown)"), { target: { value: "# Sales" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    const saved = puts[0]!;
    expect(saved.name).toBe("Sales overview");
    expect(saved.layout.find((t) => t.id === "c1")).toMatchObject({ x: 0, y: 2, w: 12, h: 4, chart_id: 10 });
    expect(saved.layout.find((t) => t.id === "t1")).toMatchObject({ type: "text", text: "# Sales" });
    expect(saved.layout).toHaveLength(4);
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByTestId("grid")).toHaveAttribute("data-editing", "false");
  });

  it("warns before leaving with unsaved changes", async () => {
    mockApi();
    const router = renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Add text" }));
    fireEvent.click(screen.getByRole("link", { name: "Dashboards" }));
    expect(await screen.findByRole("alertdialog", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/dashboards/1");

    // Stay keeps the edit.
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/dashboards/1");
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Dashboards" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Dashboards list")).toBeInTheDocument();
  });

  it("Save in the unsaved-changes dialog saves the layout, then leaves", async () => {
    const { puts } = mockApi();
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Add text" }));
    fireEvent.click(screen.getByRole("link", { name: "Dashboards" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Dashboards list")).toBeInTheDocument();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.layout).toHaveLength(5);
  });

  it("gives big number tiles the same title as other tiles, and a sweep that finishes instead of a stuck bar", async () => {
    mockApi();
    renderDashboard();
    const hero = await screen.findByTestId("tile-c1");
    await within(hero).findByTestId("big-number-value");
    const bar = screen.getByTestId("tile-c3");
    expect(within(hero).getByText("Total revenue")).toHaveClass("dash-tile-title");
    expect(bar.querySelector(".dash-tile-title")).not.toBeNull();
    // No hero-only typography: the hero rule may only change the color.
    const appCss = await readSource("App.css");
    const heroTitleRule = /\.dash-tile-hero \.dash-tile-title \{([^}]*)\}/.exec(appCss)?.[1] ?? "";
    expect(heroTitleRule).not.toMatch(/text-transform|font-family|letter-spacing|font-size/);
    expect(heroTitleRule).toMatch(/color:/);
    // Loaded: a one-time decorative sweep, not the endless "loading" line.
    expect(within(hero).getByTestId("hero-sweep")).toBeInTheDocument();
    expect(within(hero).queryByTestId("hero-loading-line")).not.toBeInTheDocument();
    expect(/\.hero-sweep \{[^}]*animation:[^;]*infinite/.test(appCss)).toBe(false);
  });

  it("shows the moving line on a hero card only while it is refreshing", async () => {
    mockApi();
    renderDashboard();
    const hero = await screen.findByTestId("tile-c1");
    await within(hero).findByTestId("big-number-value");
    // Hold every chart-data request until released.
    const pending: (() => void)[] = [];
    let held = true;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (held && String(input) === "/api/chart-data") await new Promise<void>((r) => pending.push(r));
      return original(input, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    expect(await within(hero).findByTestId("hero-loading-line")).toBeInTheDocument();
    expect(within(hero).queryByTestId("hero-sweep")).not.toBeInTheDocument();

    held = false;
    pending.splice(0).forEach((r) => r());
    expect(await within(hero).findByTestId("hero-sweep")).toBeInTheDocument();
    expect(within(hero).queryByTestId("hero-loading-line")).not.toBeInTheDocument();
  });

  it("uses the chart-data cache on load, says so, and Refresh all skips it", async () => {
    const { bodies } = mockApi();
    renderDashboard();
    const table = await screen.findByTestId("tile-c3");
    expect(await within(table).findByTestId("tile-cached")).toHaveTextContent("cached 5 minutes ago");
    expect(bodies.every((b) => !b.refresh)).toBe(true);
    expect(bodies.every((b) => b.cache_ttl === undefined)).toBe(true); // each chart's own (default)

    const before = bodies.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(bodies.length).toBeGreaterThanOrEqual(before + 3));
    expect(bodies.slice(before).every((b) => b.refresh === true)).toBe(true);
    await waitFor(() => expect(within(table).queryByTestId("tile-cached")).not.toBeInTheDocument());
  });

  it("saves a dashboard-wide cache setting and sends it with every tile", async () => {
    const { puts, bodies } = mockApi();
    renderDashboard();
    await screen.findByTestId("tile-c3");
    fireEvent.change(screen.getByLabelText("Cache"), { target: { value: "0" } });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ cache_ttl: 0, refresh_interval: "off", name: "Sales overview" });
    const before = bodies.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(bodies.length).toBeGreaterThanOrEqual(before + 3));
    expect(bodies.slice(before).every((b) => b.cache_ttl === 0)).toBe(true);
  });
});
