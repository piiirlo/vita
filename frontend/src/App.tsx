import { NavLink, Navigate, Route, Routes } from "react-router";
import BrowsePage from "./pages/BrowsePage.tsx";
import ConnectionFormPage from "./pages/ConnectionFormPage.tsx";
import ConnectionsPage from "./pages/ConnectionsPage.tsx";
import StatusPage from "./pages/StatusPage.tsx";

export default function App() {
  return (
    <>
      <header className="topbar">
        <span className="brand">Vita</span>
        <nav>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/status">Status</NavLink>
        </nav>
      </header>

      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/connections" replace />} />
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
