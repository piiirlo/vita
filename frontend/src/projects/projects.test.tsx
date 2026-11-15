/** Part 14: home = projects as folders; a project page with its dashboards and data; the
 * rail, breadcrumbs, links and API calls stay in the project; delete needs the name. */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChart, listCharts, setCurrentProject, type Project } from "../api.ts";
import App from "../App.tsx";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { innerPath, projectIdOf, projectPath, sectionOf } from "./paths.ts";
import { readSource } from "../test/readSource.ts";
import { plural, sourceLabel } from "./text.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const T = "2026-11-15T10:00:00Z";
const project = (id: number, name: string, extra: Partial<Project> = {}): Project => ({
  id, name, description: null, dashboard_count: 0, dataset_count: 0, chart_count: 0, connection_count: 0,
  saved_query_count: 0, sources: [], dashboards: [], created_at: T, updated_at: T, ...extra,
});  // prettier-ignore

const SALES = project(1, "Sales 2024", {
  dashboard_count: 2, dataset_count: 1, chart_count: 3, connection_count: 1, sources: ["database"],
  dashboards: [{ id: 5, name: "Overview", chart_count: 4 }, { id: 6, name: "Channels deep dive", chart_count: 1 }],
});  // prettier-ignore
const EMPTY = project(2, "Ops");

type Call = { url: string; method: string; body: unknown };

function mockBackend(projects: Project[] = [SALES, EMPTY]) {
  const calls: Call[] = [];
  let list = [...projects];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === "/api/auth/me") return json({ username: "admin" });
      if (url === "/api/projects" && method === "GET") return json(list);
      if (url === "/api/projects" && method === "POST") {
        const name = (body as { name: string }).name;
        if (list.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
          return json({ detail: "A project with that name already exists." }, 409);
        }
        const made = project(9, name);
        list = [...list, made];
        return json(made, 201);
      }
      const one = /^\/api\/projects\/(\d+)(\?.*)?$/.exec(url);
      if (one) {
        const found = list.find((p) => p.id === Number(one[1]));
        if (!found) return json({ detail: "Project not found" }, 404);
        if (method === "DELETE") {
          list = list.filter((p) => p !== found);
          return new Response(null, { status: 204 });
        }
        return json(found);
      }
      if (url === "/api/dashboards?project_id=1") {
        return json([{ id: 5, project_id: 1, name: "Overview", description: null, chart_count: 4, created_at: T, updated_at: T }]);
      }
      if (url === "/api/connections?project_id=1") {
        return json([
          { id: 3, project_id: 1, name: "sales_db", db_type: "postgresql", host: "h", port: 5432, database: "d", username: "u", extra: null, has_password: true, builtin: null, created_at: T, updated_at: T },
          { id: 4, project_id: null, name: "Uploads", db_type: "postgresql", host: "h", port: 5432, database: "d", username: "u", extra: null, has_password: true, builtin: "uploads", created_at: T, updated_at: T },
        ]);
      }
      if (url === "/api/datasets?project_id=1") {
        return json([{ id: 8, project_id: 1, name: "Order lines", is_upload: false }, { id: 9, project_id: 1, name: "targets", is_upload: true }]);
      }
      if (/^\/api\/(dashboards|connections|datasets|charts)\?project_id=2$/.test(url)) return json([]);
      return json({ detail: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return calls;
}

function renderApp(path: string) {
  const router = createMemoryRouter([{ path: "*", element: <AuthProvider><App /></AuthProvider> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => setCurrentProject(null));

describe("home: projects as folders", () => {
  it("shows every project as a folder with its dashboards and where its data comes from", async () => {
    mockBackend();
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Your projects" })).toBeInTheDocument();
    expect(await screen.findByText("2 projects · 2 dashboards")).toBeInTheDocument();
    const sales = screen.getByRole("button", { name: "Sales 2024, 2 dashboards" }).closest(".folder") as HTMLElement;
    expect(within(sales).getByText("Overview")).toBeInTheDocument(); // a paper per dashboard
    expect(within(sales).getByText("Database")).toBeInTheDocument();
    const ops = screen.getByRole("button", { name: "Ops, 0 dashboards" }).closest(".folder") as HTMLElement;
    expect(within(ops).getByText("No dashboards yet")).toBeInTheDocument();
    expect(within(ops).getByText("No data yet")).toBeInTheDocument();
    // The rail has only "Projects" here.
    const rail = screen.getByRole("navigation", { name: "Main" });
    expect(within(rail).getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).queryByRole("link", { name: "Charts" })).not.toBeInTheDocument();
  });

  it("opens a dashboard from its paper, and the project from anywhere else on the folder", async () => {
    mockBackend();
    const router = renderApp("/");
    const paper = await screen.findByRole("link", { name: "Channels deep dive, a dashboard in Sales 2024" });
    expect(paper).toHaveAttribute("href", "/projects/1/dashboards/6");
    expect(paper).toHaveClass("folder-paper"); // focusable: keyboard users get the same front state
    fireEvent.click(screen.getByRole("button", { name: "Sales 2024, 2 dashboards" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/1"));
  });

  it("fans the papers out on hover and brings one paper to the front (workflow-folders reference)", async () => {
    const css = await readSource("styles/projects.css");
    // The papers take the pointer (the layer around them doesn't).
    expect(/\.folder-paper \{[^}]*pointer-events: auto/.test(css)).toBe(true);
    expect(/\.folder-paper \{[^}]*transform 0\.4s var\(--fan-ease\)/.test(css)).toBe(true);
    expect(css).toContain("--fan-ease: cubic-bezier(0.2, 0.8, 0.2, 1)");
    // Folder hovered or focused: sideways, up 16px, turned more.
    const fanned = /\.folder:hover \.folder-paper,\n\.folder:focus-within \.folder-paper \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(fanned).toContain("translateX(calc(var(--x) * 1.35)) translateY(-16px) rotate(calc(var(--r) * 1.5))");
    // One paper hovered or focused: on top, straight, up 28px, 1.04, a stronger shadow.
    const front = /\.folder \.folder-paper:hover,\n\.folder \.folder-paper:focus-visible \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(front).toContain("z-index: 10;");
    expect(front).toContain("translateY(-28px) rotate(0deg) scale(1.04)");
    expect(front).toContain("box-shadow:");
  });

  it("creates a project (the name is required and unique) and opens it", async () => {
    const calls = mockBackend();
    const router = renderApp("/");
    fireEvent.click(await screen.findByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    expect(within(dialog).getByText("Each project is a folder with its own data and dashboards.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Give it a name first.");

    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "sales 2024" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(await within(dialog).findByText("A project with that name already exists.")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Marketing" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    // A new project starts with its setup.
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/9/setup"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ name: "sales 2024" }, { name: "Marketing" }]);
  });
});

describe("a project", () => {
  it("shows its dashboards and data; the rail, breadcrumbs and calls stay in the project", async () => {
    const calls = mockBackend();
    renderApp("/projects/1");
    expect(await screen.findByRole("heading", { name: "Sales 2024", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("2 dashboards · 1 dataset")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Overview\s*4 charts/ })).toHaveAttribute("href", "/projects/1/dashboards/5");
    // Data: the project's connection (not the shared Uploads one), its file and its dataset.
    expect(screen.getByRole("link", { name: /sales_db · PostgreSQL\s*Connected database/ })).toHaveAttribute("href", "/projects/1/connections/3/browse");
    expect(screen.getByRole("link", { name: /targets\s*Uploaded file/ })).toHaveAttribute("href", "/projects/1/datasets/9");
    expect(screen.getByRole("link", { name: /Order lines\s*Dataset/ })).toBeInTheDocument();
    expect(screen.queryByText(/Uploads ·/)).not.toBeInTheDocument();

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/");
    expect(within(crumbs).getByText("Sales 2024")).toHaveAttribute("aria-current", "page");

    const rail = screen.getByRole("navigation", { name: "Main" });
    expect(within(rail).getByRole("link", { name: "Dashboards" })).toHaveAttribute("href", "/projects/1");
    expect(within(rail).getByRole("link", { name: "Dashboards" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).getByRole("link", { name: "Charts" })).toHaveAttribute("href", "/projects/1/charts");
    expect(within(rail).getByRole("link", { name: "SQL Lab" })).toHaveAttribute("href", "/projects/1/sql-lab");

    const lists = calls.filter((c) => /^\/api\/(dashboards|connections|datasets)/.test(c.url)).map((c) => c.url);
    expect(lists.sort()).toEqual(["/api/connections?project_id=1", "/api/dashboards?project_id=1", "/api/datasets?project_id=1"]);
  });

  it("says how to start when it has no data", async () => {
    mockBackend();
    renderApp("/projects/2");
    expect(await screen.findByText("No data in this project yet")).toBeInTheDocument();
    expect(screen.getByText("Connect a database or upload a file to build your first chart.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/projects/2/setup");
    expect(screen.getByRole("link", { name: "Connect data" })).toHaveAttribute("href", "/projects/2/setup");
    expect(screen.queryByRole("button", { name: "New dashboard" })).not.toBeInTheDocument();
  });

  it("is deleted only after typing its name", async () => {
    const calls = mockBackend();
    const router = renderApp("/projects/1");
    await screen.findByRole("heading", { name: "Sales 2024", level: 1 });
    fireEvent.keyDown(screen.getByRole("button", { name: "Project actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete project…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Sales 2024”?" });
    expect(within(dialog).getByText(/2 dashboards, 3 charts, 1 dataset, 0 saved queries, 1 connection/)).toBeInTheDocument();
    const remove = within(dialog).getByRole("button", { name: "Delete project" });
    expect(remove).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Project name to confirm"), { target: { value: "sales 2024" } });
    expect(remove).toBeDisabled(); // exactly the name
    fireEvent.change(within(dialog).getByLabelText("Project name to confirm"), { target: { value: "Sales 2024" } });
    fireEvent.click(remove);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/projects/1?confirm=Sales%202024");
  });

  it("shows the page's own name as the last breadcrumb, under its section", async () => {
    mockBackend();
    renderApp("/projects/2/charts");
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(await within(crumbs).findByRole("link", { name: "Ops" })).toHaveAttribute("href", "/projects/2");
    expect(within(crumbs).getByText("Charts")).toHaveAttribute("aria-current", "page");
    const rail = screen.getByRole("navigation", { name: "Main" });
    expect(within(rail).getByRole("link", { name: "Charts" })).toHaveAttribute("aria-current", "page");
  });
});

describe("project scoping helpers", () => {
  it("builds project URLs", () => {
    expect(projectIdOf("/projects/3/charts/7")).toBe(3);
    expect(projectIdOf("/charts/7")).toBeNull();
    expect(innerPath("/projects/3/charts/7")).toBe("/charts/7");
    expect(innerPath("/projects/3")).toBe("/");
    expect(sectionOf("/")).toBe("home");
    expect(sectionOf("/dashboards/5")).toBe("dashboards");
    expect(sectionOf("/sql-lab")).toBe("sql-lab");
    expect(projectPath("/charts")).toBe("/charts"); // outside a project: unchanged
    setCurrentProject(3);
    expect(projectPath("/charts/new")).toBe("/projects/3/charts/new");
    expect(projectPath("/")).toBe("/projects/3");
  });

  it("asks the API for the project's items and puts new ones in it", async () => {
    const calls = mockBackend();
    setCurrentProject(4);
    await listCharts("x").catch(() => undefined);
    await createChart({ name: "c", description: null, viz_type: "table", params: { query: { dataset_id: 1 } } } as never).catch(() => undefined);
    expect(calls.map((c) => c.url)).toEqual(["/api/charts?q=x&project_id=4", "/api/charts"]);
    expect(calls[1]!.body).toMatchObject({ name: "c", project_id: 4 });
  });

  it("words things like the prototype", () => {
    expect(plural(1, "dashboard")).toBe("1 dashboard");
    expect(plural(2, "saved query")).toBe("2 saved queries");
    expect(sourceLabel([])).toBe("No data yet");
    expect(sourceLabel(["database", "file"])).toBe("Database · File");
  });
});
