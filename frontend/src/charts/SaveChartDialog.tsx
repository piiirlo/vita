import { useEffect, useId, useState, type FormEvent } from "react";
import { listDashboards, type DashboardListItem } from "../api.ts";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";
import { errorText } from "../datasets/format.ts";

/** Where to put the chart: an existing dashboard, a new one (by name), or none. */
export type DashboardTarget = { kind: "existing"; id: number; name: string } | { kind: "new"; name: string } | null;

type Props = {
  title: string;
  /** Ask for the chart's name and description (new charts, "Save as new"). */
  askName: boolean;
  initialName?: string;
  initialDescription?: string;
  /** The dashboards already showing this chart: they get the update without asking. */
  onDashboards?: { id: number; name: string }[];
  /** A dashboard must be picked ("Add to dashboard"). */
  requireDashboard?: boolean;
  submitLabel?: string;
  onSave(name: string, description: string, target: DashboardTarget): Promise<void>;
  onCancel(): void;
};

/** Save a chart, and optionally put it on a dashboard in the same step: search the existing
 * dashboards or type a new one's name. */
export default function SaveChartDialog({
  title,
  askName,
  initialName = "",
  initialDescription = "",
  onDashboards = [],
  requireDashboard = false,
  submitLabel,
  onSave,
  onCancel,
}: Props) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [adding, setAdding] = useState(requireDashboard);
  const [dashboards, setDashboards] = useState<DashboardListItem[] | null>(null);
  const [search, setSearch] = useState("");
  const [choice, setChoice] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const listId = useId();

  useEffect(() => {
    if (!adding || dashboards !== null) return;
    listDashboards()
      .then(setDashboards)
      .catch((err: unknown) => setError(errorText(err)));
  }, [adding, dashboards]);

  const already = new Set(onDashboards.map((d) => d.id));
  const q = search.trim().toLowerCase();
  const matches = (dashboards ?? []).filter((d) => !already.has(d.id) && (!q || d.name.toLowerCase().includes(q)));
  const exact = (dashboards ?? []).some((d) => d.name.toLowerCase() === q);
  const canCreate = q !== "" && !exact;

  function target(): DashboardTarget {
    if (!adding) return null;
    if (choice === "__new__") return canCreate ? { kind: "new", name: search.trim() } : null;
    const picked = (dashboards ?? []).find((d) => String(d.id) === choice);
    return picked ? { kind: "existing", id: picked.id, name: picked.name } : null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (askName && !name.trim()) {
      setError("Please enter a name.");
      return;
    }
    const where = target();
    if (adding && !where) {
      setError(canCreate ? "Pick a dashboard, or the new one." : "Pick a dashboard, or type a name for a new one.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(name.trim(), description.trim(), where);
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel} onSubmit={(e) => void submit(e)}>
      {askName && (
        <>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label>
            Description <span className="muted">(optional)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </label>
        </>
      )}
      {onDashboards.length > 0 && (
        <p className="muted small" role="note">
          On {onDashboards.map((d) => d.name).join(", ")}: {onDashboards.length === 1 ? "it shows" : "they show"} the saved chart.
        </p>
      )}
      {!requireDashboard && (
        <label className="checkbox">
          <input type="checkbox" checked={adding} onChange={(e) => setAdding(e.target.checked)} />
          Add to a dashboard
        </label>
      )}
      {adding && (
        <fieldset className="dashboard-picker">
          <legend className="sr-only">Dashboard</legend>
          <input
            type="search"
            aria-label="Find or name a dashboard"
            placeholder="Search dashboards, or type a new name"
            value={search}
            autoFocus={!askName}
            aria-controls={listId}
            onChange={(e) => {
              setSearch(e.target.value);
              if (choice === "__new__" && !e.target.value.trim()) setChoice("");
            }}
          />
          {dashboards === null && !error && <p className="muted small">Loading dashboards…</p>}
          <div id={listId} role="radiogroup" aria-label="Dashboard" className="dashboard-choices">
            {matches.slice(0, 8).map((d) => (
              <label key={d.id} className="dashboard-choice">
                <input type="radio" name="dashboard" value={d.id} checked={choice === String(d.id)} onChange={() => setChoice(String(d.id))} />
                {d.name}
              </label>
            ))}
            {canCreate && (
              <label className="dashboard-choice">
                <input type="radio" name="dashboard" value="__new__" checked={choice === "__new__"} onChange={() => setChoice("__new__")} />
                New dashboard “{search.trim()}”
              </label>
            )}
            {dashboards !== null && matches.length === 0 && !canCreate && (
              <p className="muted small">{q ? "No other dashboard matches." : "Type a name to create a dashboard."}</p>
            )}
          </div>
          <p className="control-hint">The chart goes in the first free spot.</p>
        </fieldset>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <ModalActions>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : (submitLabel ?? "Save")}
        </button>
      </ModalActions>
    </Modal>
  );
}
