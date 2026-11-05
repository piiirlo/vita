import { lazy, Suspense, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router";
import type { CurrentUser } from "./api.ts";
import { useAuth } from "./auth/auth.ts";
import UserMenu from "./auth/UserMenu.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import Toaster from "./components/Toaster.tsx";
import BrowsePage from "./pages/BrowsePage.tsx";
import ChartsPage from "./pages/ChartsPage.tsx";
import ConnectionFormPage from "./pages/ConnectionFormPage.tsx";
import ConnectionsPage from "./pages/ConnectionsPage.tsx";
import DashboardsPage from "./pages/DashboardsPage.tsx";
import DatasetEditPage from "./pages/DatasetEditPage.tsx";
import DatasetNewPage from "./pages/DatasetNewPage.tsx";
import DatasetsPage from "./pages/DatasetsPage.tsx";
import LoginPage from "./pages/LoginPage.tsx";
import NotFoundPage from "./pages/NotFoundPage.tsx";
import StatusPage from "./pages/StatusPage.tsx";

// Monaco + sql-formatter are big: load SQL Lab only when it is opened. Same for ECharts.
const SqlLabPage = lazy(() => import("./pages/SqlLabPage.tsx"));
const ChartEditorPage = lazy(() => import("./pages/ChartEditorPage.tsx"));
const DashboardPage = lazy(() => import("./pages/DashboardPage.tsx"));

const lazyPage = (page: ReactNode, what: string) => (
  <Suspense fallback={<p className="muted page-pad">Loading {what}…</p>}>{page}</Suspense>
);

/** Login gate: everything except /login needs a logged-in user. */
export default function App() {
  const { state, error, retry } = useAuth();
  const location = useLocation();

  if (location.pathname === "/login") {
    return (
      <>
        <LoginPage />
        <Toaster />
      </>
    );
  }
  if (state.status === "loading") {
    return error ? (
      <div className="page narrow">
        <p className="alert alert-error">Can't reach the Vita backend: {error}</p>
        <button onClick={retry}>Try again</button>
      </div>
    ) : (
      <p className="muted page-pad">Loading…</p>
    );
  }
  if (state.status === "anonymous") {
    const here = location.pathname + location.search;
    const next = here === "/" ? "" : `?next=${encodeURIComponent(here)}`;
    return <Navigate to={`/login${next}`} replace />;
  }
  return <Shell user={state.user} />;
}

function Shell({ user }: { user: CurrentUser }) {
  // SQL Lab and the chart editor use the full window width and height.
  const path = useLocation().pathname;
  const chartEditor = /^\/charts\/(new|\d+)/.test(path);
  const fullScreen = path.startsWith("/sql-lab") || chartEditor;
  const dashboard = /^\/dashboards\/\d+/.test(path);

  return (
    <>
      <header className="topbar">
        <span className="brand">Vita</span>
        <nav>
          <NavLink to="/dashboards">Dashboards</NavLink>
          <NavLink to="/charts">Charts</NavLink>
          <NavLink to="/sql-lab">SQL Lab</NavLink>
          <NavLink to="/datasets">Datasets</NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/status">Status</NavLink>
        </nav>
        <span className="spacer" />
        <UserMenu username={user.username} />
      </header>

      <main className={fullScreen ? `page-full${chartEditor ? " page-chart" : ""}` : dashboard ? "page-wide" : "page"}>
        {/* Keyed by path: a crash on one page doesn't stick when navigating away. */}
        <ErrorBoundary key={path}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboards" replace />} />
            <Route path="/sql-lab" element={lazyPage(<SqlLabPage />, "SQL Lab")} />
            <Route path="/dashboards" element={<DashboardsPage />} />
            <Route path="/dashboards/:id" element={lazyPage(<DashboardPage />, "dashboard")} />
            <Route path="/charts" element={<ChartsPage />} />
            <Route path="/charts/new" element={lazyPage(<ChartEditorPage />, "chart editor")} />
            <Route path="/charts/:id" element={lazyPage(<ChartEditorPage />, "chart editor")} />
            <Route path="/datasets" element={<DatasetsPage />} />
            <Route path="/datasets/new" element={<DatasetNewPage />} />
            <Route path="/datasets/:id" element={<DatasetEditPage />} />
            <Route path="/status" element={<StatusPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/connections/new" element={<ConnectionFormPage />} />
            <Route path="/connections/:id/edit" element={<ConnectionFormPage />} />
            <Route path="/connections/:id/browse" element={<BrowsePage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <Toaster />
    </>
  );
}
