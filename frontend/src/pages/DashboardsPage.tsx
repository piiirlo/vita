import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  listDashboards,
  type DashboardListItem,
} from "../api.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { errorText, relativeTime } from "../datasets/format.ts";
import SaveDialog from "../sqllab/SaveDialog.tsx";

export default function DashboardsPage() {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState<DashboardListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [toDelete, setToDelete] = useState<DashboardListItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      listDashboards(search.trim() || undefined)
        .then((data) => {
          if (cancelled) return;
          setDashboards(data);
          setError(null);
        })
        .catch((err: unknown) => !cancelled && setError(errorText(err)));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, reloadKey]);

  async function create(name: string, description: string) {
    const created = await createDashboard({ name, description: description || null, layout: [], refresh_interval: "off" });
    navigate(`/dashboards/${created.id}?edit=1`);
  }

  async function duplicate(d: DashboardListItem) {
    try {
      await duplicateDashboard(d.id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function confirmDelete(d: DashboardListItem) {
    await deleteDashboard(d.id);
    setToDelete(null);
    setReloadKey((k) => k + 1);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Dashboards</h1>
        <div className="actions">
          <input
            type="search"
            className="search-input"
            placeholder="Search dashboards…"
            aria-label="Search dashboards"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="primary" onClick={() => setCreating(true)}>
            New dashboard
          </button>
        </div>
      </div>

      {error && <p className="alert alert-error">{error}</p>}
      {dashboards === null && !error && <p className="muted">Loading…</p>}

      {dashboards?.length === 0 && (
        <div className="card empty">
          {search.trim() ? (
            <p>No dashboards match “{search.trim()}”.</p>
          ) : (
            <>
              <p>No dashboards yet.</p>
              <p className="muted small">
                Click “New dashboard”, or use “Add to dashboard” in a <Link to="/charts">chart</Link>.
              </p>
            </>
          )}
        </div>
      )}

      {dashboards && dashboards.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Charts</th>
              <th>Last updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {dashboards.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/dashboards/${d.id}`}>{d.name}</Link>
                  {d.description && <div className="muted small">{d.description}</div>}
                </td>
                <td className="num">{d.chart_count}</td>
                <td title={new Date(d.updated_at).toLocaleString()}>{relativeTime(d.updated_at)}</td>
                <td className="actions">
                  <button onClick={() => void duplicate(d)}>Duplicate</button>
                  <button className="danger" onClick={() => setToDelete(d)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating && (
        <SaveDialog
          title="New dashboard"
          initialName=""
          initialDescription=""
          onSave={create}
          onCancel={() => setCreating(false)}
        />
      )}

      {toDelete && (
        <ConfirmDialog
          title="Delete dashboard"
          confirmLabel="Delete"
          onConfirm={() => confirmDelete(toDelete)}
          onCancel={() => setToDelete(null)}
        >
          <p>
            Delete the dashboard <strong>{toDelete.name}</strong>? This cannot be undone. Its charts are not affected.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
