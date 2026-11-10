import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App.tsx";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { setThemePreference } from "../theme/theme.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const DASHBOARD = { id: 7, name: "Sales overview", description: null, chart_count: 4, created_at: "2026-11-05T10:00:00Z", updated_at: "2026-11-05T10:00:00Z" };

function mockBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return json({ username: "admin" });
      if (url === "/api/dashboards") return json([DASHBOARD]);
      if (url === "/api/charts" || url === "/api/datasets" || url === "/api/saved-queries" || url.startsWith("/api/saved-queries?")) return json([]);
      if (url === "/api/dashboards/7") return json({ ...DASHBOARD, layout: [], refresh_interval: "off", charts: {} });
      return json({ detail: `unexpected ${url}` }, 404);
    }),
  );
}

function renderApp(path: string) {
  const router = createMemoryRouter(
    [{ path: "*", element: <AuthProvider><App /></AuthProvider> }],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => setThemePreference("system"));

describe("app shell", () => {
  it("has a rail with every page, the active one marked", async () => {
    mockBackend();
    renderApp("/charts");
    const rail = await screen.findByRole("navigation", { name: "Main" });
    for (const name of ["Dashboards", "SQL Lab", "Charts", "Datasets", "Connections"]) {
      expect(within(rail).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(within(rail).getByRole("link", { name: "Charts" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).getByRole("link", { name: "Dashboards" })).not.toHaveAttribute("aria-current");

    // Tooltip with the page name (shown on keyboard focus too).
    fireEvent.focus(within(rail).getByRole("link", { name: "Datasets" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Datasets");
  });

  it("switches the theme from the rail", async () => {
    mockBackend();
    setThemePreference("light");
    renderApp("/charts");
    fireEvent.click(await screen.findByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
  });

  it("opens the command palette with Ctrl+K and jumps to a dashboard", async () => {
    mockBackend();
    const router = renderApp("/charts");
    await screen.findByRole("heading", { name: "Charts" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "sales" } });
    fireEvent.click(await within(palette).findByRole("option", { name: /Sales overview/ }));

    expect(router.state.location.pathname).toBe("/dashboards/7");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("opens the palette from the header capsule and runs Toggle theme; Escape closes it", async () => {
    mockBackend();
    setThemePreference("light");
    renderApp("/dashboards");
    fireEvent.click(await screen.findByRole("button", { name: "Search and commands" }));
    let palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(within(palette).getByRole("option", { name: /Toggle theme/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.keyDown(palette, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });
});
