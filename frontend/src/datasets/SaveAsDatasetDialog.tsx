import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError, createDataset, isQueryErrorDetail, type Dataset } from "../api.ts";
import { errorText } from "./format.ts";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";

type Props = {
  connectionId: number;
  sql: string;
  initialName: string;
  onClose(): void;
};

/** SQL Lab: save the current tab's query as a SQL dataset. */
export default function SaveAsDatasetDialog({ connectionId, sql, initialName, onClose }: Props) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Dataset | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Please enter a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      setCreated(
        await createDataset({
          name: name.trim(),
          description: description.trim() || null,
          connection_id: connectionId,
          kind: "sql",
          sql,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError && isQueryErrorDetail(err.detail) ? err.detail.message : errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Save as dataset" onClose={onClose} onSubmit={(e) => void submit(e)}>
      {created ? (
        <>
          <p className="alert alert-ok">
            Dataset “{created.name}” created with {created.column_count} column
            {created.column_count === 1 ? "" : "s"}.
          </p>
          {created.warnings.map((w) => (
            <p key={w} className="alert alert-warning small">
              {w}
            </p>
          ))}
          <ModalActions>
            <button type="button" onClick={onClose}>
              Close
            </button>
            <Link to={`/datasets/${created.id}`} className="button primary">
              Open dataset
            </Link>
          </ModalActions>
        </>
      ) : (
        <>
          <p className="muted small">
            The whole query in this tab becomes a dataset that charts can build on. It must be a single
            SELECT query.
          </p>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label>
            Description <span className="muted">(optional)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </label>
          {error && <p className="alert alert-error">{error}</p>}
          <ModalActions>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? "Reading columns…" : "Save dataset"}
            </button>
          </ModalActions>
        </>
      )}
    </Modal>
  );
}
