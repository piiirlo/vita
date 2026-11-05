import { useEffect, useState } from "react";
import { deleteSavedQuery, listSavedQueries, type SavedQuery } from "../api.ts";
import { relativeTime } from "./results.ts";

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
    if (!window.confirm(`Delete saved query "${query.name}"?`)) return;
    try {
      await deleteSavedQuery(query.id);
      onDeleted(query.id);
      setReload((r) => r + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
            <button className="tree-action danger-text" title="Delete" onClick={() => void remove(q)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
