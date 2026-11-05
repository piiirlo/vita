import { useEffect, useState } from "react";
import { listQueryHistory, type QueryHistoryItem } from "../api.ts";
import { formatDuration, relativeTime } from "./results.ts";

type Props = {
  connectionId: number | null;
  /** Bump after each run to reload. */
  refreshKey: number;
  onOpen(item: QueryHistoryItem): void;
};

export default function HistoryPanel({ connectionId, refreshKey, onOpen }: Props) {
  const [items, setItems] = useState<QueryHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (connectionId === null) return;
    let cancelled = false;
    listQueryHistory({ connectionId, limit: 50 })
      .then((page) => {
        if (!cancelled) {
          setItems(page.items);
          setError(null);
        }
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [connectionId, refreshKey]);

  if (connectionId === null) return <p className="muted small pad">Pick a connection.</p>;

  return (
    <div className="side-list">
      <p className="muted small pad">Recent runs on this connection. Click one to open it.</p>
      {error && <p className="alert alert-error compact">{error}</p>}
      {items === null && !error && <p className="muted small pad">Loading…</p>}
      {items?.length === 0 && <p className="muted small pad">No queries run yet.</p>}
      <ul>
        {items?.map((item) => (
          <li key={item.id} className="side-item">
            <button
              className="side-item-main"
              onClick={() => onOpen(item)}
              title={item.error_message ? `${item.sql}\n\nError: ${item.error_message}` : item.sql}
            >
              <span className="side-item-title mono">
                <span className={item.status === "success" ? "text-ok" : "text-error"}>
                  {item.status === "success" ? "✓" : "✗"}
                </span>{" "}
                {item.sql.replace(/\s+/g, " ").slice(0, 80)}
              </span>
              <span className="side-item-meta">
                {relativeTime(item.started_at)} · {formatDuration(item.duration_ms)}
                {item.status === "success" && item.row_count !== null
                  ? ` · ${item.row_count.toLocaleString()} rows`
                  : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
