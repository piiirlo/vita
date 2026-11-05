import { useEffect, useState } from "react";
import { deleteSavedQuery, listSavedQueries, type SavedQuery } from "../api.ts";
import { relativeTime } from "./results.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { toast } from "../components/toast.ts";

type Props = {
  /** Bump to reload (after saving). */
  refreshKey: number;
  onOpen(query: SavedQuery): void;
  onDeleted(id: number): void;
};

export default function SavedQueriesPanel({ refreshKey, onOpen, onDeleted }: Props) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<SavedQuery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [toDelete, setToDelete] = useState<SavedQuery | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Debounce typing in the search box.
    const timer = setTimeout(() => {
      listSavedQueries(search)
        .then((data) => {
          if (!cancelled) {
            setItems(data);
            setError(null);
          }
        })
        .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, refreshKey, reload]);

  async function remove(query: SavedQuery) {
    await deleteSavedQuery(query.id); // errors are shown in the dialog
    setToDelete(null);
    toast.success(`Deleted "${query.name}".`);
    onDeleted(query.id);
    setReload((r) => r + 1);
  }

  return (
    <div className="side-list">
      <div className="panel-search">
        <input
          type="search"
          placeholder="Search saved queries"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search saved queries"
        />
      </div>
      {error && <p className="alert alert-error compact">{error}</p>}
      {items === null && !error && <p className="muted small pad">Loading…</p>}
      {items?.length === 0 && (
        <p className="muted small pad">
          {search ? "No matches." : "No saved queries yet. Use Save in the toolbar."}
        </p>
      )}
      <ul>
        {items?.map((q) => (
          <li key={q.id} className="side-item">
            <button className="side-item-main" onClick={() => onOpen(q)} title={q.sql}>
              <span className="side-item-title">{q.name}</span>
              {q.description && <span className="side-item-sub">{q.description}</span>}
              <span className="side-item-meta">
                {q.connection_name ?? "no connection"} · {relativeTime(q.updated_at)}
              </span>
            </button>
            <button className="tree-action danger-text" title="Delete" onClick={() => setToDelete(q)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {toDelete && (
        <ConfirmDialog
          title="Delete saved query"
          confirmLabel="Delete"
          onConfirm={() => remove(toDelete)}
          onCancel={() => setToDelete(null)}
        >
          <p>
            Delete the saved query <strong>{toDelete.name}</strong>? This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
