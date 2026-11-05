import { useEffect, useState } from "react";
import { Link } from "react-router";
import { deleteDataset, listDatasets, type DatasetListItem } from "../api.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { errorText, relativeTime } from "../datasets/format.ts";
import { usePageTitle } from "../components/usePageTitle.ts";
import { toast } from "../components/toast.ts";
import EmptyState from "../components/EmptyState.tsx";

export default function DatasetsPage() {
  usePageTitle("Datasets");
  const [datasets, setDatasets] = useState<DatasetListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [toDelete, setToDelete] = useState<DatasetListItem | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      listDatasets(search.trim() || undefined)
        .then((data) => {
          if (cancelled) return;
          setDatasets(data);
          setError(null);
        })
        .catch((err: unknown) => !cancelled && setError(errorText(err)));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, reloadKey]);

  async function confirmDelete(dataset: DatasetListItem) {
    await deleteDataset(dataset.id);
    toast.success(`Deleted "${dataset.name}".`);
    setToDelete(null);
    setReloadKey((k) => k + 1);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Datasets</h1>
        <div className="actions">
          <input
            type="search"
            className="search-input"
            placeholder="Search datasets…"
            aria-label="Search datasets"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Link to="/datasets/new" className="button primary">
            New dataset
          </Link>
        </div>
      </div>

      {error && <p className="alert alert-error">{error}</p>}
      {datasets === null && !error && <p className="muted">Loading…</p>}

      {datasets?.length === 0 &&
        (search.trim() ? (
          <EmptyState title={`No datasets match “${search.trim()}”.`}>Try a different search.</EmptyState>
        ) : (
          <EmptyState title="No datasets yet">
            Create one from a table, or write a query in <Link to="/sql-lab">SQL Lab</Link> and use “Save as dataset”.
          </EmptyState>
        ))}

      {datasets && datasets.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Connection</th>
              <th>Source</th>
              <th className="num">Columns</th>
              <th>Last updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/datasets/${d.id}`}>{d.name}</Link>
                  {d.description && <div className="muted small">{d.description}</div>}
                </td>
                <td>{d.connection_name}</td>
                <td>
                  <span className="tag">{d.kind === "table" ? "table" : "SQL"}</span>{" "}
                  {d.kind === "table" && (
                    <span className="mono small">
                      {d.schema}.{d.table_name}
                    </span>
                  )}
                </td>
                <td className="num">{d.column_count}</td>
                <td title={new Date(d.updated_at).toLocaleString()}>{relativeTime(d.updated_at)}</td>
                <td className="actions">
                  <Link to={`/datasets/${d.id}`} className="button">
                    Edit
                  </Link>
                  <button className="danger" onClick={() => setToDelete(d)}>
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
          title="Delete dataset"
          confirmLabel="Delete"
          onConfirm={() => confirmDelete(toDelete)}
          onCancel={() => setToDelete(null)}
        >
          <p>
            Delete <strong>{toDelete.name}</strong> with its column settings and metrics? This cannot be
            undone. The table or query in the database is not affected.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
