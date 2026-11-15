/** Part 14 round 2: a new project's setup (Connect data → Explore → Query → Chart) and a
 * dashboard's "Add a chart", through the real pages with a fake backend. */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCurrentProject, type SchemaDiagram } from "../api.ts";
import { DATASET } from "../charts/testData.ts";
import ChartEditorPage from "../pages/ChartEditorPage.tsx";
import SetupPage from "../pages/SetupPage.tsx";
import ProjectProvider from "../projects/ProjectProvider.tsx";

vi.mock("../charts/EChart.tsx", () => ({ default: ({ label }: { label: string }) => <div role="img" aria-label={label} /> }));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const T = "2026-11-15T10:00:00Z";
const PROJECT = {
  id: 2, name: "Ops", description: null, dashboard_count: 0, dataset_count: 0, chart_count: 0, connection_count: 0,
  saved_query_count: 0, sources: [], dashboards: [], setup_draft: null, created_at: T, updated_at: T,
};  // prettier-ignore
const CONNECTION = {
  id: 3, project_id: 2, name: "sales_db", db_type: "postgresql", host: "db", port: 5432, database: "sales_db",
  username: "reader", extra: null, has_password: true, builtin: null, created_at: T, updated_at: T,
};  // prettier-ignore
const DIAGRAM: SchemaDiagram = {
  schema_name: "sales", truncated: false,
  tables: [
    { name: "orders", type: "table", columns: [
      { name: "order_id", type: "integer", nullable: false, primary_key: true, foreign_key: false },
      { name: "order_date", type: "date", nullable: false, primary_key: false, foreign_key: false },
      { name: "status", type: "text", nullable: true, primary_key: false, foreign_key: false },
      { name: "channel", type: "text", nullable: true, primary_key: false, foreign_key: false },
    ] },
    { name: "order_items", type: "table", columns: [
      { name: "order_id", type: "integer", nullable: false, primary_key: false, foreign_key: true },
      { name: "quantity", type: "integer", nullable: false, primary_key: false, foreign_key: false },
    ] },
  ],
  foreign_keys: [{ name: null, table: "order_items", columns: ["order_id"], referred_schema: "sales", referred_table: "orders", referred_columns: ["order_id"] }],
};  // prettier-ignore
const CREATED = {
  ...DATASET, id: 4, project_id: 2, name: "Order lines", kind: "sql", main_time_column: null,
  columns: ["order_date", "channel", "quantity"].map((name, i) => ({
    ...DATASET.columns[0]!, id: 40 + i, name, generic_type: name === "order_date" ? "date" : name === "quantity" ? "number" : "string",
    is_temporal: false, is_dimension: false,
  })),
};  // prettier-ignore

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function mockBackend(extra: (url: string, method: string, body: Record<string, unknown> | null) => Response | null = () => null) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      const special = extra(url, method, body);
      if (special) return special;
      if (url === "/api/projects/2") return json(PROJECT);
      if (url === "/api/projects/2/setup-draft") return method === "DELETE" ? new Response(null, { status: 204 }) : json({ ...PROJECT, setup_draft: body?.draft });
      if (url === "/api/connections/test") return json({ ok: true, error: null });
      if (url === "/api/connections" && method === "POST") return json({ ...CONNECTION, name: body?.name }, 201);
      if (url === "/api/connections/3") return json(CONNECTION);
      if (url === "/api/connections/3/schemas") return json(["sales"]);
      if (url === "/api/connections/3/schemas/sales/diagram") return json(DIAGRAM);
      if (url === "/api/query") {
        return json({
          columns: [{ name: "order_date", type: "date", db_type: "date" }, { name: "channel", type: "string", db_type: "text" }, { name: "quantity", type: "number", db_type: "int4" }],
          rows: [["2024-01-03", "Web", 2]], row_count: 1, truncated: false, duration_ms: 48,
        });
      }
      if (url === "/api/datasets" && method === "POST") return json(CREATED, 201);
      if (url === "/api/datasets/4" && method === "PUT") return json({ ...CREATED, main_time_column: "order_date" });
      if (url === "/api/datasets/4") return json({ ...DATASET, project_id: 2 });
      if (url === "/api/datasets?project_id=2") return json([{ ...DATASET, project_id: 2, columns: undefined }]);
      if (url === "/api/chart-data") {
        return json({ columns: [{ name: "count", type: "number", db_type: "int8" }], rows: [[12]], row_count: 1, truncated: false, duration_ms: 5, sql: "SELECT 1" });
      }
      return json({ detail: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const inProject = (el: React.ReactNode) => <ProjectProvider id={2}>{el}</ProjectProvider>;
  const router = createMemoryRouter(
    [
      { path: "/projects/:projectId/setup", element: inProject(<SetupPage mode="project" />) },
      { path: "/projects/:projectId/dashboards/:id/add-chart", element: inProject(<SetupPage mode="add" />) },
      { path: "/projects/:projectId/charts/new", element: inProject(<ChartEditorPage />) },
      { path: "/projects/:projectId/dashboards/:id", element: <p>Dashboard page</p> },
      { path: "/projects/:projectId", element: <p>Project page</p> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => setCurrentProject(null));

describe("setting up a project", () => {
  it("connects a database, marks columns, runs the starter query and saves it as a dataset", async () => {
    const calls = mockBackend();
    const router = renderAt("/projects/2/setup");

    // 1. Connect data
    expect(await screen.findByRole("heading", { name: "Where does your data live?" })).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Steps" });
    expect(within(steps).getByText("Connect data").closest("li")).toHaveAttribute("aria-current", "step");
    const next = () => screen.getByRole("button", { name: /^(Continue|Build a chart)$/ });
    expect(next()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Connect a database/ }));
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db" } });
    fireEvent.change(screen.getByLabelText("Database"), { target: { value: "sales_db" } });
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "reader" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/sales_db · PostgreSQL · read-only access/)).toBeInTheDocument();
    const created = calls.find((c) => c.url === "/api/connections" && c.method === "POST")!;
    expect(created.body).toMatchObject({ name: "sales_db", host: "db", project_id: 2 });
    fireEvent.click(next());

    // 2. Explore: the schema with tables; dates are time, text is a breakdown.
    expect(await screen.findByRole("heading", { name: "Look around your data" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /orders/, pressed: true })).toBeInTheDocument();
    expect(screen.getByText("order_items → orders via order_id")).toBeInTheDocument();
    const statusRow = screen.getByText("status").closest("tr")!;
    const groupStatus = within(statusRow).getByRole("checkbox", { name: "Group by" });
    expect(groupStatus).toBeChecked();
    fireEvent.click(groupStatus); // not a breakdown
    expect(within(screen.getByText("order_date").closest("tr")!).getByRole("checkbox", { name: "Time column" })).toBeChecked();
    const draftAfterSource = calls.filter((c) => c.url === "/api/projects/2/setup-draft").at(-1)!;
    expect(draftAfterSource.body?.draft).toMatchObject({ step: "explore", connectionId: 3 });
    expect(JSON.stringify(draftAfterSource.body)).not.toContain("pw"); // never the password
    fireEvent.click(next());

    // 3. Query: a starter query from the foreign keys; run it; save it as a dataset.
    expect(await screen.findByRole("heading", { name: "Write your first query" })).toBeInTheDocument();
    const sql = screen.getByLabelText("SQL query");
    expect(sql).toHaveValue('SELECT o."order_date",\n       o."channel",\n       oi."quantity"\nFROM "sales"."orders" o\nJOIN "sales"."order_items" oi ON oi."order_id" = o."order_id"');
    expect(next()).toBeDisabled(); // run it first
    fireEvent.click(screen.getByRole("button", { name: "Run ▸" }));
    expect(await screen.findByText("48 ms")).toBeInTheDocument();
    expect(screen.getByLabelText("Save this as a dataset")).toHaveValue("Order lines");
    fireEvent.click(next());

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/2/charts/new"));
    expect(router.state.location.search).toBe("?dataset=4&setup=1");
    const dataset = calls.find((c) => c.url === "/api/datasets" && c.method === "POST")!;
    expect(dataset.body).toMatchObject({ name: "Order lines", connection_id: 3, kind: "sql", project_id: 2 });
    const marked = calls.find((c) => c.url === "/api/datasets/4" && c.method === "PUT")!;
    expect(marked.body).toMatchObject({ main_time_column: "order_date" });
    const flags = (marked.body!.columns as { id: number; is_temporal: boolean; is_dimension: boolean }[]).map((c) => [c.id, c.is_temporal, c.is_dimension]);
    expect(flags).toEqual([
      [40, true, false],
      [41, false, true],
      [42, false, false],
    ]);
    expect(calls.filter((c) => c.url === "/api/projects/2/setup-draft").at(-1)!.body?.draft).toMatchObject({ step: "chart", datasetId: 4 });
  });

  it("ends in the chart editor: saving makes the chart and the project's Overview dashboard", async () => {
    const calls = mockBackend((url, method, body) => {
      if (url === "/api/dashboards?project_id=2") return json([{ id: 1, project_id: 2, name: "Overview", description: null, chart_count: 0, created_at: T, updated_at: T }]);
      if (url === "/api/charts" && method === "POST") return json({ id: 8, project_id: 2, name: body?.name, description: null, dataset_id: 4, dataset_name: "orders", viz_type: body?.viz_type, params: body?.params, created_at: T, updated_at: T, dashboards: [] }, 201);
      if (url === "/api/dashboards" && method === "POST") return json({ id: 12, project_id: 2, name: body?.name, description: null, layout: body?.layout, refresh_interval: "off", cache_ttl: null, charts: {}, created_at: T, updated_at: T }, 201);
      return null;
    });
    const router = renderAt("/projects/2/charts/new?dataset=4&setup=1");
    const steps = await screen.findByRole("list", { name: "Steps" });
    expect(within(steps).getByText("Chart").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Saving adds it to a new dashboard in this project")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save chart" }));
    const dialog = await screen.findByRole("dialog", { name: "Save chart" });
    expect(within(dialog).getByRole("note")).toHaveTextContent("Saving adds it to a new dashboard “Overview 2” in Ops.");
    expect(within(dialog).queryByRole("checkbox", { name: "Add to a dashboard" })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Count");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/2/dashboards/12"));
    const dashboard = calls.find((c) => c.url === "/api/dashboards" && c.method === "POST")!;
    expect(dashboard.body).toMatchObject({ name: "Overview 2", project_id: 2 });
    expect((dashboard.body!.layout as { chart_id: number }[])[0]).toMatchObject({ type: "chart", chart_id: 8 });
    expect(calls.some((c) => c.url === "/api/projects/2/setup-draft" && c.method === "DELETE")).toBe(true);
  });
});

describe("a dashboard's Add a chart", () => {
  it("picks a dataset of the project, then the chart lands on that dashboard", async () => {
    const calls = mockBackend((url, method, body) => {
      if (url === "/api/dashboards/5") return json({ id: 5, project_id: 2, name: "Sales overview", description: null, layout: [], refresh_interval: "off", cache_ttl: null, charts: {}, created_at: T, updated_at: T });
      if (url === "/api/connections?project_id=2") return json([CONNECTION]);
      if (url === "/api/charts" && method === "POST") return json({ id: 8, project_id: 2, name: body?.name, description: null, dataset_id: 4, dataset_name: "orders", viz_type: body?.viz_type, params: body?.params, created_at: T, updated_at: T, dashboards: [] }, 201);
      if (url === "/api/dashboards/5/charts") return json({ id: 5, project_id: 2, name: "Sales overview", description: null, layout: [], refresh_interval: "off", cache_ttl: null, charts: {}, created_at: T, updated_at: T });
      return null;
    });
    const router = renderAt("/projects/2/dashboards/5/add-chart");
    expect(await screen.findByRole("heading", { name: "What data is this chart about?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use a dataset", pressed: true })).toBeInTheDocument();
    expect(screen.getByText("The chart goes on “Sales overview”")).toBeInTheDocument();
    // The first dataset is picked already: Build a chart is ready.
    const build = screen.getByRole("button", { name: "Build a chart" });
    await waitFor(() => expect(build).toBeEnabled());
    fireEvent.click(build);
    await waitFor(() => expect(router.state.location.search).toBe("?dataset=4&target=5"));

    fireEvent.click(await screen.findByRole("button", { name: "Save chart" }));
    const dialog = await screen.findByRole("dialog", { name: "Save chart" });
    expect(within(dialog).getByRole("note")).toHaveTextContent("Saving adds it to “Sales overview”, in the first free spot.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/2/dashboards/5"));
    expect(calls.find((c) => c.url === "/api/dashboards/5/charts")!.body).toEqual({ chart_id: 8 });
  });

  it("can write new SQL instead, on one of the project's databases", async () => {
    mockBackend((url) => {
      if (url === "/api/dashboards/5") return json({ id: 5, project_id: 2, name: "Sales overview", description: null, layout: [], refresh_interval: "off", cache_ttl: null, charts: {}, created_at: T, updated_at: T });
      if (url === "/api/connections?project_id=2") return json([CONNECTION]);
      return null;
    });
    const router = renderAt("/projects/2/dashboards/5/add-chart");
    fireEvent.click(await screen.findByRole("button", { name: "Write new SQL" }));
    fireEvent.change(screen.getByLabelText("SQL query"), { target: { value: "SELECT * FROM sales.orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Run ▸" }));
    expect(await screen.findByText("48 ms")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Save this as a dataset"), { target: { value: "Orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Build a chart" }));
    await waitFor(() => expect(router.state.location.search).toBe("?dataset=4&target=5"));
  });
});
