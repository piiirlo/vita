import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllCaches } from "../sqllab/schemaCache.ts";
import { STORAGE_KEY } from "../sqllab/tabs.ts";
import SqlLabPage from "./SqlLabPage.tsx";

// Monaco doesn't run in jsdom: a textarea stands in for the editor.
vi.mock("@monaco-editor/react", () => ({
  default: ({ defaultValue, onChange }: { defaultValue: string; onChange(v?: string): void }) => (
    <textarea aria-label="SQL editor" defaultValue={defaultValue} onChange={(e) => onChange(e.target.value)} />
  ),
  loader: { config: () => undefined },
}));
vi.mock("../sqllab/monacoSetup.ts", () => ({
  setupMonaco: () => undefined,
  setCompletionContext: () => undefined,
}));

const CONNECTION = {
  id: 1,
  name: "Sample DB",
  db_type: "postgresql",
  host: "sampledb",
  port: 5432,
  database: "sampledb",
  username: "demo",
  has_password: true,
  extra: null,
  created_at: "2026-11-05T10:00:00Z",
  updated_at: "2026-11-05T10:00:00Z",
};

const RESULT = {
  columns: [
    { name: "id", type: "number", db_type: "int4" },
    { name: "status", type: "string", db_type: "text" },
    { name: "shipped", type: "date", db_type: "date" },
  ],
  rows: [
    [1, "completed", "2025-01-02"],
    [2, "cancelled", null],
    [3, "shipped", "2025-03-04"],
  ],
  row_count: 3,
  truncated: true,
  duration_ms: 42,
};

type Reply = { status?: number; body: unknown };

function json({ status = 200, body }: Reply): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockApi(queryReply: Reply = { body: RESULT }) {
  const queries: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/connections") return json({ body: [CONNECTION] });
    if (url === "/api/connections/1/schemas") return json({ body: ["public", "sales"] });
    if (url === "/api/connections/1/schemas/public/tables") return json({ body: [] });
    if (url === "/api/connections/1/schemas/sales/tables") {
      return json({ body: [{ name: "orders", type: "table" }] });
    }
    if (url.startsWith("/api/query-history")) {
      return json({ body: { items: [], total: 0, limit: 50, offset: 0 } });
    }
    if (url.startsWith("/api/saved-queries")) return json({ body: [] });
    if (url === "/api/query") {
      queries.push(JSON.parse(String(init?.body)));
      return json(queryReply);
    }
    return json({ status: 404, body: { detail: `unexpected ${url}` } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { queries };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SqlLabPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearAllCaches();
});

describe("SQL Lab page", () => {
  it("loads with the connection, schema, editor and Run button", async () => {
    mockApi();
    renderPage();

    const connection = await screen.findByLabelText("Connection");
    expect(within(connection).getByRole("option", { name: "Sample DB" })).toBeInTheDocument();
    expect(screen.getByLabelText("SQL editor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run/ })).toBeInTheDocument();
    // "public" has no tables, so the schema with tables is picked.
    await waitFor(() => expect(screen.getByLabelText("Schema")).toHaveValue("sales"));
    expect(await screen.findByRole("button", { name: "orders" })).toBeInTheDocument();
  });

  it("runs a query and shows rows, row count, NULLs and the truncated notice", async () => {
    const { queries } = mockApi();
    renderPage();

    fireEvent.change(await screen.findByLabelText("SQL editor"), {
      target: { value: "SELECT * FROM sales.orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    expect(await screen.findByText("completed")).toBeInTheDocument();
    expect(screen.getByText("cancelled")).toBeInTheDocument();
    expect(screen.getByText("NULL")).toHaveClass("null");
    expect(screen.getByRole("status")).toHaveTextContent("Showing the first 3 rows");
    expect(screen.getByText("42 ms")).toBeInTheDocument();
    // Column type in the header.
    expect(screen.getByRole("columnheader", { name: /shipped\s*date/ })).toBeInTheDocument();
    expect(queries).toEqual([{ connection_id: 1, sql: "SELECT * FROM sales.orders", limit: 1000 }]);
  });

  it("sorts by clicking a column header", async () => {
    mockApi();
    renderPage();
    fireEvent.change(await screen.findByLabelText("SQL editor"), { target: { value: "SELECT 1" } });
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    await screen.findByText("completed");

    fireEvent.click(screen.getByRole("columnheader", { name: /status/ }));
    const statuses = () =>
      screen.getAllByRole("gridcell").filter((c) => ["completed", "cancelled", "shipped"].includes(c.textContent ?? ""));
    expect(statuses().map((c) => c.textContent)).toEqual(["cancelled", "completed", "shipped"]);
  });

  it("shows a failed query's error message", async () => {
    mockApi({
      status: 400,
      body: {
        detail: {
          kind: "syntax",
          message: "Syntax error at line 1, column 8: unexpected token",
          line: 1,
          column: 8,
        },
      },
    });
    renderPage();
    fireEvent.change(await screen.findByLabelText("SQL editor"), { target: { value: "SELECT +* 2" } });
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Syntax error at line 1, column 8");
  });

  it("keeps open tabs in localStorage", async () => {
    mockApi();
    renderPage();
    fireEvent.change(await screen.findByLabelText("SQL editor"), { target: { value: "SELECT 'kept'" } });
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { tabs?: { sql: string }[] };
      expect(saved.tabs?.map((t) => t.sql)).toEqual(["SELECT 'kept'", ""]);
    });
  });
});
