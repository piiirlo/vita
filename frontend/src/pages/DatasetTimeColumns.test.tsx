/** Part 13: year numbers, text dates, identifiers and notes on the dataset page; friendly
 * errors in metric validation. */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Dataset, DatasetColumn } from "../api.ts";
import Toaster from "../components/Toaster.tsx";
import DatasetEditPage from "./DatasetEditPage.tsx";

function column(id: number, name: string, type: DatasetColumn["generic_type"], extra: Partial<DatasetColumn> = {}): DatasetColumn {
  return {
    id, name, position: id, label: null, raw_type: type, generic_type: type, generic_type_override: null,
    effective_type: type, is_temporal: false, is_dimension: type === "string", is_hidden: false,
    is_missing: false, description: null, ...extra,
  };
}

const DATASET: Dataset = {
  id: 9, name: "Video games", description: null, connection_id: 1, connection_name: "Uploads",
  kind: "table", schema: "uploads", table_name: "vgsales", column_count: 6, metric_count: 1,
  created_at: "2026-11-05T10:00:00Z", updated_at: "2026-11-05T10:00:00Z", db_type: "postgresql",
  sql: null, main_time_column: "year",
  columns: [
    column(1, "year", "number", { is_temporal: true, time_kind: "year_number" }),
    column(2, "season", "number", { looks_like_years: true }),
    column(3, "release_text", "string"),
    column(4, "rank", "number", { is_identifier: true }),
    column(5, "is_hit", "boolean"),
    column(6, "old_year", "number", { is_temporal: true, time_kind: "pending" }),
  ],
  metrics: [{ id: 1, name: "count", label: "Count", expression: "COUNT(*)", description: null, number_format: null, is_builtin: true }],
  warnings: [], sqllab_sql: "SELECT 1", is_upload: false, upload_source: null,
  notes: [{ id: "n1", message: "“old” was marked as a time column, but its values aren't years.", created_at: "2026-11-12T10:00:00Z" }],
};  // prettier-ignore

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
      if (url === "/api/datasets/9" && method === "GET") return json(DATASET);
      if (url === "/api/datasets/9" && method === "PUT") return json(DATASET);
      if (url === "/api/datasets/9/notes/n1" && method === "DELETE") return new Response(null, { status: 204 });
      if (url === "/api/datasets/9/metrics/validate") {
        return json({
          ok: false,
          error: {
            kind: "other", message: "division by zero", line: null, column: null,
            title: "Division by zero", hint: "Wrap the divisor in NULLIF(…, 0).", raw: "ERROR: division by zero",
          },
          warning: null, value: null,
        });  // prettier-ignore
      }
      return json({ detail: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return calls;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/datasets/9"]}>
      <Routes>
        <Route path="/datasets/:id" element={<DatasetEditPage />} />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );
}

const row = (name: string) => screen.getByText(name, { selector: ".mono" }).closest("tr")!;

describe("Dataset time columns", () => {
  it("shows year numbers, columns not checked yet and identifiers", async () => {
    mockApi();
    renderPage();
    await screen.findByDisplayValue("Video games");
    expect(within(row("year")).getByText("year (number)")).toBeInTheDocument();
    expect(within(row("old_year")).getByText("not checked yet")).toBeInTheDocument();
    expect(screen.getByLabelText("rank is an identifier")).toBeChecked();
    expect(screen.getByLabelText("year is an identifier")).not.toBeChecked();
    // Booleans can't be time columns.
    expect(screen.getByLabelText("is_hit is temporal")).toBeDisabled();
  });

  it("suggests years and sends only what changed", async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByDisplayValue("Video games");
    fireEvent.click(within(row("season")).getByRole("button", { name: "Looks like years, use as time?" }));
    expect(screen.getByLabelText("season is temporal")).toBeChecked();
    expect(within(row("season")).getByText("year (number)")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("rank is an identifier"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const put = calls.find((c) => c.method === "PUT")!.body as { columns: Record<string, unknown>[] };
    expect(put.columns).toEqual([
      expect.objectContaining({ id: 2, is_temporal: true }),
      expect.objectContaining({ id: 4, is_identifier: false }),
    ]);
    expect(put.columns[0]).not.toHaveProperty("is_identifier");
    expect(put.columns[0]).not.toHaveProperty("text_date_format");
  });

  it("asks for a text column's date format", async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByDisplayValue("Video games");
    fireEvent.click(screen.getByLabelText("release_text is temporal"));
    const format = screen.getByLabelText("Date format of release_text");
    expect(format).toHaveValue("");
    expect(within(format).getByRole("option", { name: "Text date: detect the format" })).toBeInTheDocument();
    fireEvent.change(format, { target: { value: "dmy" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const put = calls.find((c) => c.method === "PUT")!.body as { columns: Record<string, unknown>[] };
    expect(put.columns).toEqual([expect.objectContaining({ id: 3, is_temporal: true, text_date_format: "dmy" })]);
  });

  it("shows notes that can be dismissed", async () => {
    const calls = mockApi();
    renderPage();
    expect(await screen.findByText(/was marked as a time column/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this note" }));
    await waitFor(() => expect(screen.queryByText(/was marked as a time column/)).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/datasets/9/notes/n1")).toBe(true);
  });

  it("explains metric errors, with the raw error under Details", async () => {
    mockApi();
    renderPage();
    await screen.findByDisplayValue("Video games");
    fireEvent.click(screen.getByRole("tab", { name: /Metrics/ }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add metric" }));
    fireEvent.change(screen.getByLabelText("SQL expression"), { target: { value: "SUM(a) / 0" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    const status = await screen.findByText("Division by zero");
    const box = status.closest("[role=status]") as HTMLElement;
    expect(within(box).getByText("Wrap the divisor in NULLIF(…, 0).")).toBeInTheDocument();
    expect(within(box).queryByText("ERROR: division by zero")).not.toBeInTheDocument();
    const details = within(box).getByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(details);
    expect(within(box).getByText("ERROR: division by zero")).toBeInTheDocument();
  });
});
