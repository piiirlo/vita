import { lazy, Suspense } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router";
import BrowsePage from "./pages/BrowsePage.tsx";
import ConnectionFormPage from "./pages/ConnectionFormPage.tsx";
import ConnectionsPage from "./pages/ConnectionsPage.tsx";
import DatasetEditPage from "./pages/DatasetEditPage.tsx";
import DatasetNewPage from "./pages/DatasetNewPage.tsx";
import DatasetsPage from "./pages/DatasetsPage.tsx";
import StatusPage from "./pages/StatusPage.tsx";

// Monaco + sql-formatter are big: load SQL Lab only when it is opened.
const SqlLabPage = lazy(() => import("./pages/SqlLabPage.tsx"));

export default function App() {
  // SQL Lab uses the full window width and height.
  const fullScreen = useLocation().pathname.startsWith("/sql-lab");

  return (
    <>
      <header className="topbar">
        <span className="brand">Vita</span>
        <nav>
          <NavLink to="/sql-lab">SQL Lab</NavLink>
          <NavLink to="/datasets">Datasets</NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/status">Status</NavLink>
        </nav>
      </header>

      <main className={fullScreen ? "page-full" : "page"}>
        <Routes>
          <Route path="/" element={<Navigate to="/sql-lab" replace />} />
          <Route
            path="/sql-lab"
            element={
              <Suspense fallback={<p className="muted page-pad">Loading SQL Lab…</p>}>
                <SqlLabPage />
              </Suspense>
            }
          />
          <Route path="/datasets" element={<DatasetsPage />} />
          <Route path="/datasets/new" element={<DatasetNewPage />} />
          <Route path="/datasets/:id" element={<DatasetEditPage />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/connections/new" element={<ConnectionFormPage />} />
          <Route path="/connections/:id/edit" element={<ConnectionFormPage />} />
          <Route path="/connections/:id/browse" element={<BrowsePage />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
