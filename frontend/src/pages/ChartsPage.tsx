import { useEffect, useState } from "react";
import { Link } from "react-router";
import { deleteChart, listCharts, type SavedChart } from "../api.ts";
import { VIZ_TYPES } from "../charts/model.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { errorText, relativeTime } from "../datasets/format.ts";
import { usePageTitle } from "../components/usePageTitle.ts";
import { toast } from "../components/toast.ts";
import EmptyState from "../components/EmptyState.tsx";

const vizLabel = (viz: string) => VIZ_TYPES.find((v) => v.value === viz)?.label ?? viz;

export default function ChartsPage() {
  usePageTitle("Charts");
  const [charts, setCharts] = useState<SavedChart[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [toDelete, setToDelete] = useState<SavedChart | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      listCharts(search.trim() || undefined)
        .then((data) => {
          if (cancelled) return;
          setCharts(data);
          setError(null);
        })
        .catch((err: unknown) => !cancelled && setError(errorText(err)));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, reloadKey]);

  async function confirmDelete(chart: SavedChart) {
    await deleteChart(chart.id);
    toast.success(`Deleted "${chart.name}".`);
    setToDelete(null);
    setReloadKey((k) => k + 1);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Charts</h1>
        <div className="actions">
          <input
            type="search"
            className="search-input"
            placeholder="Search charts…"
            aria-label="Search charts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Link to="/charts/new" className="button primary">
            New chart
          </Link>
        </div>
      </div>

      {error && <p className="alert alert-error">{error}</p>}
      {charts === null && !error && <p className="muted">Loading…</p>}

      {charts?.length === 0 &&
        (search.trim() ? (
          <EmptyState title={`No charts match “${search.trim()}”.`}>Try a different search.</EmptyState>
        ) : (
          <EmptyState title="No charts yet">
            Start from a <Link to="/datasets">dataset</Link> (“Create chart”), or click “New chart”.
          </EmptyState>
        ))}

      {charts && charts.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Dataset</th>
              <th>Last updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {charts.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/charts/${c.id}`}>{c.name}</Link>
                  {c.description && <div className="muted small">{c.description}</div>}
                </td>
                <td>
                  <span className="tag">{vizLabel(c.viz_type)}</span>
                </td>
                <td>
                  <Link to={`/datasets/${c.dataset_id}`}>{c.dataset_name}</Link>
                </td>
                <td title={new Date(c.updated_at).toLocaleString()}>{relativeTime(c.updated_at)}</td>
                <td className="actions">
                  <Link to={`/charts/${c.id}`} className="button">
                    Edit
                  </Link>
                  <button className="danger" onClick={() => setToDelete(c)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {toDelete && (
        <ConfirmDialog
          title="Delete chart"
          confirmLabel="Delete"
          onConfirm={() => confirmDelete(toDelete)}
          onCancel={() => setToDelete(null)}
        >
          <p>
            Delete the chart <strong>{toDelete.name}</strong>? This cannot be undone. Its dataset is not affected.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
