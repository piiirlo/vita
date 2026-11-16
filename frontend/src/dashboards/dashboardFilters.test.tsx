import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { AppliedDashboardFilter, Dashboard, DashboardFilterDef, SavedChart } from "../api.ts";
import { defaultQuery } from "../charts/model.ts";
import { DATASET } from "../charts/testData.ts";
import DashboardPage from "../pages/DashboardPage.tsx";

vi.mock("../charts/EChart.tsx", () => ({
  default: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}));
vi.mock("./DashboardGrid.tsx", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="grid">{children}</div>,
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const STATUS: DashboardFilterDef = {
  id: "st",
  kind: "values",
  label: "Status",
  column: "status",
  dataset_id: 4,
  targets: null,
  default: {},
};
const COUNTRY: DashboardFilterDef = { ...STATUS, id: "co", label: "Country", column: "country", default: { values: ["NL"] } };

const DASHBOARD: Dashboard = {
  id: 1,
  name: "Sales overview",
  description: null,
  layout: [{ id: "c1", type: "chart", chart_id: 10, x: 0, y: 0, w: 12, h: 8 }],
  cache_ttl: null,
  refresh_interval: "off",
  charts: { "10": { id: 10, name: "Orders by status", viz_type: "table" } },
  filters: [STATUS, COUNTRY],
  cross_filtering: true,
  created_at: "2026-11-05T10:00:00Z",
  updated_at: "2026-11-05T10:00:00Z",
};

const CHART: SavedChart = {
  id: 10,
  name: "Orders by status",
  description: null,
  dataset_id: 4,
  dataset_name: DATASET.name,
  viz_type: "table",
  params: { query: { ...defaultQuery(DATASET), metrics: ["revenue"], dimensions: ["status"] }, display: {} },
  created_at: DASHBOARD.created_at,
  updated_at: DASHBOARD.updated_at,
};

type Body = { dashboard_filters?: AppliedDashboardFilter[]; refresh?: boolean };

function mockApi(dashboard: Dashboard = DASHBOARD) {
  const puts: Dashboard[] = [];
  const bodies: Body[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      urls.push(url);
      if (url === "/api/dashboards/1" && method === "GET") return json(dashboard);
      if (url === "/api/dashboards/1" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Dashboard;
        puts.push(body);
        return json({ ...dashboard, ...body });
      }
      if (url === "/api/charts/10") return json(CHART);
      if (url === "/api/datasets/4") return json(DATASET);
      if (url.startsWith("/api/datasets/4/values?")) {
        return json({ column: "status", values: ["completed", "returned", null], truncated: false, cached_at: null });
      }
      if (url === "/api/chart-data") {
        const body = JSON.parse(String(init?.body)) as Body;
        bodies.push(body);
        // The dataset has a status column but no country column.
        const applied = (body.dashboard_filters ?? []).filter((f) => f.column === "status").map((f) => f.id);
        return json({
          columns: [{ name: "status", type: "string", db_type: "text" }, { name: "revenue", type: "number", db_type: "numeric" }],
          rows: [["completed", 1234.5]],
          row_count: 1,
          truncated: false,
          duration_ms: 3,
          sql: "SELECT …",
          dashboard_filters_applied: applied,
        });
      }
      return json({ detail: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return { puts, bodies, urls };
}

function renderDashboard(url = "/dashboards/1") {
  const router = createMemoryRouter([{ path: "/dashboards/:id", element: <DashboardPage /> }], { initialEntries: [url] });
  render(<RouterProvider router={router} />);
  return router;
}

const lastFilters = (bodies: Body[]) => bodies[bodies.length - 1]?.dashboard_filters ?? [];

describe("Dashboard filters", () => {
  it("sends the URL's values (else the defaults) to the charts that have the column", async () => {
    const { bodies } = mockApi();
    const value = encodeURIComponent(JSON.stringify({ values: ["returned"] }));
    renderDashboard(`/dashboards/1?f_st=${value}`);
    const bar = await screen.findByRole("region", { name: "Dashboard filters" });
    expect(within(bar).getByRole("button", { name: /Status\s*returned/ })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /Country\s*NL/ })).toBeInTheDocument();
    const tile = screen.getByTestId("tile-c1");
    expect(await within(tile).findByRole("img", { name: "Filtered by Status" })).toBeInTheDocument();
    // Country targets nothing here: the dataset has no such column, so it isn't even sent.
    expect(lastFilters(bodies)).toEqual([{ id: "st", kind: "values", column: "status", values: ["returned"] }]);
  });

  it("charts a filter doesn't apply to say so", async () => {
    mockApi({ ...DASHBOARD, filters: [{ ...COUNTRY, targets: [10] }] });
    renderDashboard();
    // Explicitly targeted, but the backend didn't apply it.
    expect(await within(await screen.findByTestId("tile-c1")).findByTestId("tile-unfiltered")).toHaveTextContent("Not filtered by Country");
  });

  it("picking values updates the URL at once and the charts after a short pause", async () => {
    const { bodies } = mockApi();
    const router = renderDashboard();
    await within(await screen.findByTestId("tile-c1")).findByText("completed");
    const loads = bodies.length;
    fireEvent.click(screen.getByRole("button", { name: /Status\s*All/ }));
    const list = await screen.findByRole("list", { name: "Status values" });
    expect(within(list).getByText("(empty)")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("checkbox", { name: "returned" }));
    fireEvent.click(within(list).getByRole("checkbox", { name: "(empty)" }));
    expect(new URLSearchParams(router.state.location.search).get("f_st")).toBe(JSON.stringify({ values: ["returned", null] }));
    expect(bodies.length).toBe(loads); // debounced
    await waitFor(() => expect(lastFilters(bodies)).toEqual([{ id: "st", kind: "values", column: "status", values: ["returned", null] }]));
    // A filter change may use the cache.
    expect(bodies[bodies.length - 1]?.refresh).toBeUndefined();
  });

  it("Reset goes back to the defaults; Save as default stores the current values", async () => {
    const { puts } = mockApi();
    const value = encodeURIComponent(JSON.stringify({ values: ["returned"] }));
    const router = renderDashboard(`/dashboards/1?f_st=${value}&f_co={}`);
    fireEvent.click(await screen.findByRole("button", { name: /Reset/ }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.queryByRole("button", { name: /Reset/ })).not.toBeInTheDocument();

    await act(() => router.navigate(`/dashboards/1?f_st=${value}`));
    fireEvent.click(await screen.findByRole("button", { name: /Save as default/ }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.filters?.map((f) => [f.id, f.default])).toEqual([
      ["st", { values: ["returned"] }],
      ["co", { values: ["NL"] }],
    ]);
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("edit mode adds a time range filter and saves it with the dashboard", async () => {
    const { puts } = mockApi({ ...DASHBOARD, filters: [] });
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: /Add filter/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add filter" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Time range/ }));
    fireEvent.change(within(dialog).getByLabelText(/Label/), { target: { value: "Period" } });
    await within(dialog).findByText("Orders by status");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add filter" }));
    expect(await screen.findByRole("button", { name: "Edit filter Period" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.filters).toEqual([
      expect.objectContaining({ kind: "time", label: "Period", column: null, dataset_id: null, targets: null, default: {} }),
    ]);
  });

  it("a values filter needs a column", async () => {
    mockApi({ ...DASHBOARD, filters: [] });
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: /Add filter/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add filter" });
    await waitFor(() => expect(within(dialog).getByLabelText("Column")).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Add filter" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Pick a column.");
    fireEvent.change(within(dialog).getByLabelText("Column"), { target: { value: "status" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add filter" }));
    expect(await screen.findByRole("button", { name: "Edit filter status" })).toBeInTheDocument();
  });
});

describe("Cross-filtering", () => {
  const TWO_TILES: Dashboard = {
    ...DASHBOARD,
    filters: [],
    layout: [
      { id: "c1", type: "chart", chart_id: 10, x: 0, y: 0, w: 12, h: 8 },
      { id: "c2", type: "chart", chart_id: 10, x: 12, y: 0, w: 12, h: 8 },
    ],
  };
  const crossIds = (b: Body) => (b.dashboard_filters ?? []).map((f) => f.id);

  it("clicking a row filters the other charts; the same row again removes it", async () => {
    const { bodies } = mockApi(TWO_TILES);
    const router = renderDashboard();
    const source = await screen.findByTestId("tile-c1");
    fireEvent.click(await within(source).findByText("completed"));
    expect(JSON.parse(new URLSearchParams(router.state.location.search).get("xf")!)).toEqual([
      { tile: "c1", conditions: [{ column: "status", values: ["completed"] }] },
    ]);
    const chip = await screen.findByTestId("cross-chip");
    expect(chip).toHaveTextContent("Orders by status");
    expect(chip).toHaveTextContent("status: completed");
    expect(await within(source).findByTestId("tile-crossing")).toHaveTextContent("Filtering");
    await waitFor(() => expect(bodies.some((b) => crossIds(b).includes("x_c1_0"))).toBe(true));
    // Only the other tile got it, and says so.
    expect(bodies.filter((b) => crossIds(b).includes("x_c1_0"))).toHaveLength(1);
    expect(await within(screen.getByTestId("tile-c2")).findByRole("img", { name: "Filtered by status: completed" })).toBeInTheDocument();

    fireEvent.click(within(source).getByText("completed"));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.queryByTestId("cross-chip")).not.toBeInTheDocument();
  });

  it("the chip removes it; the switch turns cross-filtering off and clears it", async () => {
    const { puts } = mockApi(TWO_TILES);
    const router = renderDashboard();
    fireEvent.click(await within(await screen.findByTestId("tile-c1")).findByText("completed"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove cross filter status: completed" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));

    fireEvent.click(within(screen.getByTestId("tile-c2")).getByText("completed"));
    expect(await screen.findByTestId("cross-chip")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Cross-filter" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.cross_filtering).toBe(false);
    await waitFor(() => expect(router.state.location.search).toBe(""));
    // Off: rows no longer select.
    fireEvent.click(within(screen.getByTestId("tile-c1")).getByText("completed"));
    expect(router.state.location.search).toBe("");
  });
});

describe("Dependent filters", () => {
  it("a values filter only asks for values matching the filters it depends on", async () => {
    const city: DashboardFilterDef = { ...STATUS, id: "ci", label: "City", depends_on: ["co"] };
    const { urls } = mockApi({ ...DASHBOARD, filters: [COUNTRY, city] });
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: /City\s*All/}));
    await screen.findByRole("list", { name: "City values" });
    const valuesUrl = urls.find((u) => u.startsWith("/api/datasets/4/values?"))!;
    expect(JSON.parse(new URL(valuesUrl, "http://x").searchParams.get("filters")!)).toEqual([
      { id: "co", kind: "values", column: "country", values: ["NL"] },
    ]);
    expect(screen.getByText("Only values that match Country.")).toBeInTheDocument();
  });

  it("the filter dialog sets what a values filter is limited by", async () => {
    const { puts } = mockApi({ ...DASHBOARD, filters: [COUNTRY] });
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: /Add filter/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add filter" });
    await waitFor(() => expect(within(dialog).getByLabelText("Column")).not.toBeDisabled());
    fireEvent.change(within(dialog).getByLabelText("Column"), { target: { value: "status" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Country/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add filter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.filters?.[1]).toMatchObject({ column: "status", depends_on: ["co"] });
  });
});
