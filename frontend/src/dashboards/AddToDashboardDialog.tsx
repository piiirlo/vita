import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  addChartToDashboard,
  createDashboard,
  listDashboards,
  type Dashboard,
  type DashboardListItem,
} from "../api.ts";
import { errorText } from "../datasets/format.ts";
import { addChartTile } from "./layout.ts";

type Props = {
  chartId: number;
  chartName: string;
  onClose(): void;
};

const NEW = "new";

/** Chart editor: add the saved chart to an existing dashboard or to a new one. */
export default function AddToDashboardDialog({ chartId, chartName, onClose }: Props) {
  const [dashboards, setDashboards] = useState<DashboardListItem[] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Dashboard | null>(null);

  useEffect(() => {
    listDashboards()
      .then((list) => {
        setDashboards(list);
        setChoice(list[0] ? String(list[0].id) : NEW);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (choice === NEW && !newName.trim()) {
      setError("Please enter a name for the new dashboard.");
      return;
    }
    setBusy(true);
    try {
      const dashboard =
        choice === NEW
          ? await createDashboard({
              name: newName.trim(),
              description: null,
              layout: addChartTile([], chartId),
              refresh_interval: "off",
            })
          : await addChartToDashboard(Number(choice), chartId);
      setAdded(dashboard);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal card form"
        role="dialog"
        aria-label="Add to dashboard"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => void submit(e)}
      >
        <h2 className="modal-title">Add “{chartName}” to a dashboard</h2>
        {added ? (
          <>
            <p className="alert alert-ok" role="status">
              Added to <strong>{added.name}</strong>.
            </p>
            <div className="form-actions">
              <span className="spacer" />
              <button type="button" onClick={onClose}>
                Close
              </button>
              <Link className="button primary" to={`/dashboards/${added.id}`}>
                Open dashboard
              </Link>
            </div>
          </>
        ) : (
          <>
            {dashboards === null && !error && <p className="muted small">Loading dashboards…</p>}
            {dashboards !== null && (
              <label>
                Dashboard
                <select value={choice} onChange={(e) => setChoice(e.target.value)} autoFocus>
                  {dashboards.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                  <option value={NEW}>New dashboard…</option>
                </select>
              </label>
            )}
            {choice === NEW && (
              <label>
                New dashboard name
                <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={200} autoFocus />
              </label>
            )}
            {error && <p className="alert alert-error">{error}</p>}
            <div className="form-actions">
              <span className="spacer" />
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || dashboards === null}>
                {busy ? "Adding…" : "Add"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
