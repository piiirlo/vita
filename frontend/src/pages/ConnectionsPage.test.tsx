import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConnectionsPage from "./ConnectionsPage.tsx";

const base = {
  db_type: "postgresql",
  host: "db",
  port: 5432,
  username: "u",
  has_password: true,
  extra: null,
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("Connections page", () => {
  it("shows the built-in Uploads connection with a badge and without Edit / Delete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { ...base, id: 1, name: "Sample DB", database: "sampledb", builtin: null },
            { ...base, id: 2, name: "Uploads", database: "vita_uploads", builtin: "uploads" },
          ]),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    render(
      <MemoryRouter>
        <ConnectionsPage />
      </MemoryRouter>,
    );
    const uploads = (await screen.findByRole("link", { name: "Uploads" })).closest("tr")!;
    expect(within(uploads).getByText("Uploads", { selector: ".tag" })).toBeInTheDocument();
    expect(within(uploads).queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(uploads).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(uploads).getByRole("button", { name: "Test" })).toBeInTheDocument();
    const sample = screen.getByRole("link", { name: "Sample DB" }).closest("tr")!;
    expect(within(sample).getByRole("link", { name: "Edit" })).toBeInTheDocument();
    expect(within(sample).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
