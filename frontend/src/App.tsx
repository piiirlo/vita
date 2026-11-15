import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import type { CurrentUser } from "./api.ts";
import { useAuth } from "./auth/auth.ts";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import { PageTransition } from "./components/PageTransition.tsx";
import Toaster from "./components/Toaster.tsx";
import { SkeletonLines } from "./components/ui/skeleton.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import BrowsePage from "./pages/BrowsePage.tsx";
import ChartsPage from "./pages/ChartsPage.tsx";
import ConnectionFormPage from "./pages/ConnectionFormPage.tsx";
import ConnectionsPage from "./pages/ConnectionsPage.tsx";
import DashboardsPage from "./pages/DashboardsPage.tsx";
import DatasetNewPage from "./pages/DatasetNewPage.tsx";
import DatasetsPage from "./pages/DatasetsPage.tsx";
import HomePage from "./pages/HomePage.tsx";
import LoginPage from "./pages/LoginPage.tsx";
import NotFoundPage from "./pages/NotFoundPage.tsx";
import ProjectPage from "./pages/ProjectPage.tsx";
import StatusPage from "./pages/StatusPage.tsx";
import Breadcrumbs from "./projects/Breadcrumbs.tsx";
import { innerPath, projectIdOf } from "./projects/paths.ts";
import ProjectProvider from "./projects/ProjectProvider.tsx";
import CommandPaletteHost from "./shell/CommandPaletteHost.tsx";
import Rail from "./shell/Rail.tsx";

// Monaco + sql-formatter are big: load SQL Lab only when it is opened. Same for ECharts.
const SqlLabPage = lazy(() => import("./pages/SqlLabPage.tsx"));
const ChartEditorPage = lazy(() => import("./pages/ChartEditorPage.tsx"));
const DashboardPage = lazy(() => import("./pages/DashboardPage.tsx"));
// The dataset editor's preview grid (TanStack Table + Virtual) is only needed there.
const DatasetEditPage = lazy(() => import("./pages/DatasetEditPage.tsx"));
const UploadPage = lazy(() => import("./pages/UploadPage.tsx"));
const SetupPage = lazy(() => import("./pages/SetupPage.tsx"));

const lazyPage = (page: ReactNode, what: string) => (
  <Suspense fallback={<SkeletonLines lines={4} label={`Loading ${what}…`} className="page-pad max-w-xl" />}>{page}</Suspense>
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
      // Empty, full-height: the shell appears without anything jumping (no layout shift).
      <div className="min-h-screen" role="status" aria-label="Loading…" />
    );
  }
  if (state.status === "anonymous") {
    const here = location.pathname + location.search;
    const next = here === "/" ? "" : `?next=${encodeURIComponent(here)}`;
    return <Navigate to={`/login${next}`} replace />;
  }
  return <Shell user={state.user} />;
}

/** The pages a project has, under /projects/:id (and at the old top-level URLs, where
 * they show every project's items). */
function pageRoutes(prefix: string) {
  return (
    <>
      <Route path={`${prefix}/sql-lab`} element={lazyPage(<SqlLabPage />, "SQL Lab")} />
      <Route path={`${prefix}/dashboards`} element={<DashboardsPage />} />
      <Route path={`${prefix}/dashboards/:id`} element={lazyPage(<DashboardPage />, "dashboard")} />
      <Route path={`${prefix}/dashboards/:id/add-chart`} element={lazyPage(<SetupPage mode="add" />, "add a chart")} />
      <Route path={`${prefix}/charts`} element={<ChartsPage />} />
      <Route path={`${prefix}/charts/new`} element={lazyPage(<ChartEditorPage />, "chart editor")} />
      <Route path={`${prefix}/charts/:id`} element={lazyPage(<ChartEditorPage />, "chart editor")} />
      <Route path={`${prefix}/datasets`} element={<DatasetsPage />} />
      <Route path={`${prefix}/datasets/new`} element={<DatasetNewPage />} />
      <Route path={`${prefix}/datasets/upload`} element={lazyPage(<UploadPage />, "upload")} />
      <Route path={`${prefix}/datasets/:id`} element={lazyPage(<DatasetEditPage />, "dataset")} />
      <Route path={`${prefix}/connections`} element={<ConnectionsPage />} />
      <Route path={`${prefix}/connections/new`} element={<ConnectionFormPage />} />
      <Route path={`${prefix}/connections/:id/edit`} element={<ConnectionFormPage />} />
      <Route path={`${prefix}/connections/:id/browse`} element={<BrowsePage />} />
    </>
  );
}

function Shell({ user }: { user: CurrentUser }) {
  const path = useLocation().pathname;
  const projectId = projectIdOf(path);
  // SQL Lab and the chart editor use the full window width and height.
  const inner = innerPath(path);
  const chartEditor = /^\/charts\/(new|\d+)/.test(inner);
  const fullScreen = inner.startsWith("/sql-lab") || chartEditor;
  const dashboard = /^\/dashboards\/\d+/.test(inner);

  return (
    <TooltipProvider delayDuration={300}>
      <ProjectProvider id={projectId}>
        <div className="app-shell">
          <Rail username={user.username} />

          <main className={fullScreen ? `page-full${chartEditor ? " page-chart" : ""}` : dashboard ? "page-wide" : "page"}>
            <Breadcrumbs />
            {/* Keyed by path: a crash on one page doesn't stick when navigating away, and each
                page fades in and rises 12px when it opens. */}
            <ErrorBoundary key={path}>
              <PageTransition key={path} className="page-transition">
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/projects/:projectId" element={<ProjectPage />} />
                  <Route path="/projects/:projectId/setup" element={lazyPage(<SetupPage mode="project" />, "setup")} />
                  {pageRoutes("/projects/:projectId")}
                  {pageRoutes("")}
                  <Route path="/status" element={<StatusPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </PageTransition>
            </ErrorBoundary>
          </main>
        </div>
        <CommandPaletteHost />
      </ProjectProvider>
      <Toaster />
    </TooltipProvider>
  );
}
