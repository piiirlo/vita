import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import App from "./App.tsx";
import { safeNext } from "./auth/auth.ts";
import { AuthProvider } from "./auth/AuthContext.tsx";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fake backend with one user ("admin" / "secret password"). */
function mockBackend({ loggedIn = false } = {}) {
  let session = loggedIn;
  const logins: { username: string; password: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/auth/login" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { username: string; password: string };
        logins.push(body);
        if (body.username === "admin" && body.password === "secret password") {
          session = true;
          return json({ username: "admin" });
        }
        return json({ detail: "Wrong username or password." }, 401);
      }
      if (url === "/api/auth/logout") {
        session = false;
        return new Response(null, { status: 204 });
      }
      if (!session) return json({ detail: "Please log in." }, 401);
      if (url === "/api/auth/me") return json({ username: "admin" });
      if (url === "/api/charts") return json([]);
      if (url === "/api/dashboards") return json([]);
      return json({ detail: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return {
    logins,
    expireSession: () => {
      session = false;
    },
  };
}

function renderApp(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <AuthProvider>
            <App />
          </AuthProvider>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("login", () => {
  it("redirects to the login page when not logged in, and back to the wanted page after login", async () => {
    const { logins } = mockBackend();
    const router = renderApp("/charts?q=x");

    expect(await screen.findByRole("form", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(new URLSearchParams(router.state.location.search).get("next")).toBe("/charts?q=x");
    expect(screen.queryByRole("link", { name: "Charts" })).not.toBeInTheDocument(); // no nav

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret password" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("heading", { name: "Charts" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/charts");
    expect(router.state.location.search).toBe("?q=x");
    expect(logins).toEqual([{ username: "admin", password: "secret password" }]);
    expect(screen.getByRole("button", { name: /admin/ })).toBeInTheDocument();
    expect(document.title).toBe("Charts · Vita");
  });

  it("shows a clear message on wrong credentials", async () => {
    mockBackend();
    renderApp("/dashboards");
    await screen.findByRole("form", { name: "Log in" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong username or password.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("goes to the dashboards when logged in and opening /", async () => {
    mockBackend({ loggedIn: true });
    const router = renderApp("/");
    expect(await screen.findByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/dashboards");
  });

  it("returns to the login page when the session ends, and logs out from the user menu", async () => {
    const backend = mockBackend({ loggedIn: true });
    const router = renderApp("/charts");
    await screen.findByRole("heading", { name: "Charts" });

    backend.expireSession();
    fireEvent.click(screen.getByRole("link", { name: "Dashboards" }));
    expect(await screen.findByText("Your session has ended. Please log in again.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");

    // Log in again, then log out from the menu.
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret password" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await screen.findByRole("heading", { name: "Dashboards" });
    // The account menu (a Radix dropdown) opens from the keyboard like for real users.
    fireEvent.keyDown(screen.getByRole("button", { name: /admin/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));
    expect(await screen.findByRole("form", { name: "Log in" })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("shows a 404 page for unknown URLs", async () => {
    mockBackend({ loggedIn: true });
    renderApp("/no/such/page");
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to dashboards" })).toBeInTheDocument();
  });

  it("only follows same-site paths after login", () => {
    expect(safeNext("/charts/3?x=1")).toBe("/charts/3?x=1");
    expect(safeNext("https://evil.example")).toBe("/dashboards");
    expect(safeNext("//evil.example")).toBe("/dashboards");
    expect(safeNext("/\\evil.example")).toBe("/dashboards");
    expect(safeNext("/login")).toBe("/dashboards");
    expect(safeNext(null)).toBe("/dashboards");
  });
});
