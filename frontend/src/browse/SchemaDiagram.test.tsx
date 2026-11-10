import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import SchemaDiagram from "./SchemaDiagram.tsx";
import { SALES } from "./testData.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi(diagram: unknown = SALES, status = 200) {
  const queries: { connection_id: number; sql: string; limit: number }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/connections/2/schemas/sales/diagram") return json(diagram, status);
      if (url === "/api/query") {
        queries.push(JSON.parse(String(init?.body)) as (typeof queries)[number]);
        return json({ columns: [{ name: "id", type: "number", db_type: "int4" }, { name: "name", type: "string", db_type: "text" }], rows: [[1, "Ada"], [2, null]], row_count: 2, truncated: false, duration_ms: 3 });
      }
      return json({ detail: `unexpected ${url}` }, 404);
    }),
  );
  return queries;
}

function SqlLab() {
  const location = useLocation();
  return <pre data-testid="sql-lab-state">{JSON.stringify(location.state)}</pre>;
}

function renderDiagram() {
  return render(
    <MemoryRouter initialEntries={["/connections/2/browse"]}>
      <Routes>
        <Route path="/connections/2/browse" element={<SchemaDiagram connectionId={2} dbType="postgresql" schema="sales" />} />
        <Route path="/sql-lab" element={<SqlLab />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SchemaDiagram", () => {
  it("shows every table as a collapsed card with keys, and expands a card's columns", async () => {
    mockApi();
    renderDiagram();
    const orders = await screen.findByTestId("table-orders");
    expect(orders).toHaveTextContent("orders");
    expect(orders).toHaveTextContent("2 cols · PK id · 1 FK");
    expect(within(screen.getByTestId("table-order_totals")).getByText("view")).toBeInTheDocument();
    expect(within(orders).queryByText("customer_id")).not.toBeInTheDocument();

    fireEvent.click(within(orders).getByRole("button", { name: "Expand orders" }));
    expect(within(orders).getByText("customer_id")).toBeInTheDocument();
    expect(within(orders).getByLabelText("Foreign key")).toBeInTheDocument();
    expect(within(orders).getByLabelText("Primary key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(within(orders).queryByText("customer_id")).not.toBeInTheDocument();
    // One line per foreign key.
    expect(document.querySelectorAll(".diagram-edge")).toHaveLength(3);
  });

  it("search highlights a table and its neighbors and dims the rest", async () => {
    mockApi();
    renderDiagram();
    await screen.findByTestId("table-orders");
    fireEvent.change(screen.getByLabelText("Find a table"), { target: { value: "orders" } });
    expect(screen.getByText("1 found")).toBeInTheDocument();
    expect(screen.getByTestId("table-orders")).toHaveClass("is-active");
    expect(screen.getByTestId("table-customers")).toHaveClass("is-near");
    expect(screen.getByTestId("table-order_items")).toHaveClass("is-near");
    expect(screen.getByTestId("table-products")).toHaveClass("is-dim");
    expect(document.querySelectorAll(".diagram-edge.is-lit")).toHaveLength(2);
    // Enter glides to the match.
    fireEvent.keyDown(screen.getByLabelText("Find a table"), { key: "Enter" });
    expect(document.querySelector(".diagram-canvas")).toHaveClass("gliding");
  });

  it("zooms with the buttons", async () => {
    mockApi();
    renderDiagram();
    await screen.findByTestId("table-orders");
    const level = () => Number(screen.getByLabelText("Zoom level").textContent!.replace("%", ""));
    const before = level();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(level()).toBeGreaterThan(before);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(level()).toBeLessThan(before);
  });

  it("a click on a table shows its columns, Preview and Open in SQL Lab", async () => {
    const queries = mockApi();
    renderDiagram();
    fireEvent.click(within(await screen.findByTestId("table-customers")).getByRole("button", { name: "customers" }));
    const panel = screen.getByRole("complementary", { name: "Table customers" });
    expect(within(panel).getByText("name")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "orders" })).toBeInTheDocument(); // referenced by orders

    fireEvent.click(within(panel).getByRole("button", { name: "Preview" }));
    expect(await within(panel).findByText("Ada")).toBeInTheDocument();
    expect(queries).toEqual([{ connection_id: 2, sql: 'SELECT *\nFROM "sales"."customers"\nLIMIT 20', limit: 20 }]);

    fireEvent.click(within(panel).getByRole("button", { name: "Open in SQL Lab" }));
    const state = JSON.parse((await screen.findByTestId("sql-lab-state")).textContent!) as { openTab: Record<string, unknown> };
    expect(state.openTab).toEqual({ title: "customers", sql: 'SELECT *\nFROM "sales"."customers"\nLIMIT 100', connectionId: 2, schema: "sales" });
  });

  it("shows a clear error", async () => {
    mockApi({ detail: "permission denied for schema sales" }, 400);
    renderDiagram();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("permission denied for schema sales"));
  });
});
