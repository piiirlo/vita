import { useEffect, useState } from "react";
import { listCharts, type SavedChart } from "../api.ts";
import { VIZ_TYPES } from "../charts/model.ts";
import { errorText } from "../datasets/format.ts";

type Props = {
  onPick(chart: SavedChart): void;
  onClose(): void;
};

/** Pick a saved chart (with search) to add to the dashboard. */
export default function AddChartDialog({ onPick, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [charts, setCharts] = useState<SavedChart[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      listCharts(search.trim() || undefined)
        .then((data) => !cancelled && (setCharts(data), setError(null)))
        .catch((err: unknown) => !cancelled && setError(errorText(err)));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal modal-wide card form"
        role="dialog"
        aria-label="Add chart"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h2 className="modal-title">Add chart</h2>
        <input
          type="search"
          className="search-input"
          placeholder="Search charts…"
          aria-label="Search charts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        {error && <p className="alert alert-error">{error}</p>}
        <div className="pick-list">
          {charts === null && !error && <p className="muted small">Loading…</p>}
          {charts?.length === 0 && <p className="muted small">{search.trim() ? "No charts match." : "No saved charts yet."}</p>}
          {charts?.map((c) => (
            <button key={c.id} className="pick-item" onClick={() => onPick(c)}>
              <span>{c.name}</span>
              <span className="tag">{VIZ_TYPES.find((v) => v.value === c.viz_type)?.label ?? c.viz_type}</span>
              <span className="muted small">{c.dataset_name}</span>
            </button>
          ))}
        </div>
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
