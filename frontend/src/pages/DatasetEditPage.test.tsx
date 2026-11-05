import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Dataset, DatasetColumn } from "../api.ts";
import DatasetEditPage from "./DatasetEditPage.tsx";

function column(id: number, name: string, type: DatasetColumn["generic_type"], extra: Partial<DatasetColumn> = {}): DatasetColumn {
  return {
    id,
    name,
    position: id,
    label: null,
    raw_type: type === "number" ? "INTEGER" : type === "date" ? "DATE" : "TEXT",
    generic_type: type,
    generic_type_override: null,
    effective_type: type,
    is_temporal: type === "date",
    is_dimension: type === "string",
    is_hidden: false,
    is_missing: false,
    description: null,
    ...extra,
  };
}

const DATASET: Dataset = {
  id: 7,
  name: "Orders",
  description: null,
  connection_id: 1,
  connection_name: "Sample DB",
  kind: "table",
  schema: "sales",
  table_name: "orders",
  column_count: 3,
  metric_count: 1,
  created_at: "2026-11-05T10:00:00Z",
  updated_at: "2026-11-05T10:00:00Z",
  db_type: "postgresql",
  sql: null,
  main_time_column: "order_date",
  columns: [
    column(1, "id", "number"),
    column(2, "order_date", "date"),
    column(3, "status", "string", { label: "Order status" }),
    column(4, "old_column", "string", { is_missing: true }),
  ],
  metrics: [
    {
      id: 1,
      name: "count",
      label: "Count",
      expression: "COUNT(*)",
      description: null,
      number_format: null,
      is_builtin: true,
    },
  ],
  warnings: [],
  sqllab_sql: 'SELECT * FROM "sales"."orders"',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body });
      if (url === "/api/datasets/7" && method === "GET") return json(DATASET);
      if (url === "/api/datasets/7" && method === "PUT") return json({ ...DATASET, main_time_column: null });
      if (url === "/api/datasets/7/metrics/validate") {
        const { expression } = body as { expression: string };
        return expression.includes("nope")
          ? json({
              ok: false,
              error: { kind: "not_found", message: 'column "nope" does not exist', line: null, column: null },
              warning: null,
              value: null,
            })
          : json({ ok: true, error: null, warning: null, value: 12345.5 });
      }
      if (url === "/api/datasets/7/preview") {
        return json({
          columns: [{ name: "id", type: "number", db_type: "int4" }, { name: "status", type: "string", db_type: "text" }],
          rows: [[1, "completed"], [2, "shipped"]],
          row_count: 2,
          truncated: false,
          duration_ms: 12,
          sql: 'SELECT * FROM "sales"."orders"',
        });
      }
      return json({ detail: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return calls;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/datasets/7"]}>
      <Routes>
        <Route path="/datasets/:id" element={<DatasetEditPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Dataset edit page", () => {
  it("loads and shows the columns with their settings", async () => {
    mockApi();
    renderPage();

    expect(await screen.findByRole("heading", { name: /Orders/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Columns (3)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("order_date")).toBeInTheDocument();
    expect(screen.getByLabelText("Label of status")).toHaveValue("Order status");
    expect(screen.getByLabelText("order_date is temporal")).toBeChecked();
    expect(screen.getByLabelText("order_date is the main time column")).toBeChecked();
    expect(screen.getByLabelText("status is a dimension")).toBeChecked();
    // The missing column is flagged and can be removed.
    expect(screen.getByText("missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves only the changed column settings", async () => {
    const calls = mockApi();
    renderPage();

    fireEvent.change(await screen.findByLabelText("Label of id"), { target: { value: "Order ID" } });
    fireEvent.click(screen.getByLabelText("No main time column"));
    expect(screen.getByRole("button", { name: "Sync columns" })).toBeDisabled(); // unsaved changes
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({
      name: "Orders",
      description: null,
      main_time_column: null,
      columns: [
        {
          id: 1,
          label: "Order ID",
          generic_type_override: null,
          is_temporal: false,
          is_dimension: false,
          is_hidden: false,
          description: null,
        },
      ],
      delete_column_ids: [],
    });
  });

  it("validates a metric expression and shows success or the error", async () => {
    mockApi();
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Metrics (1)" }));
    expect(screen.getByText("COUNT(*)")).toBeInTheDocument();
    // The built-in count metric can't be deleted.
    const row = screen.getByText("COUNT(*)").closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+ Add metric" }));
    const expression = screen.getByLabelText("SQL expression");
    fireEvent.change(expression, { target: { value: "SUM(nope)" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByText(/column "nope" does not exist/)).toBeInTheDocument();

    fireEvent.change(expression, { target: { value: "SUM(quantity * unit_price)" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByText("✓ Valid")).toBeInTheDocument();
    expect(screen.getByText("12345.5")).toBeInTheDocument();
  });

  it("previews the data in the results grid", async () => {
    mockApi();
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Preview" }));
    expect(await screen.findByText("completed")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('SELECT * FROM "sales"."orders"')).toBeInTheDocument());
  });
});
