import { useState, type FormEvent } from "react";
import { deleteProject, type Project } from "../api.ts";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";
import { errorText } from "../datasets/format.ts";
import { plural } from "./text.ts";

/** Deleting a project deletes everything in it: the user types its name to confirm. */
export default function DeleteProjectDialog({
  project,
  onDeleted,
  onCancel,
}: {
  project: Project;
  onDeleted(): void;
  onCancel(): void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const matches = typed.trim() === project.name;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteProject(project.id, typed.trim());
      onDeleted();
    } catch (err) {
      setError(errorText(err));
      setDeleting(false);
    }
  }

  const contents = [
    plural(project.dashboard_count, "dashboard"),
    plural(project.chart_count, "chart"),
    plural(project.dataset_count, "dataset"),
    plural(project.saved_query_count, "saved query"),
    plural(project.connection_count, "connection"),
  ].join(", ");

  return (
    <Modal title={`Delete “${project.name}”?`} onClose={onCancel} onSubmit={(e) => void submit(e)}>
      <p className="m-0">
        This deletes everything in the project: {contents}, and the tables made from its uploaded files. It can't be
        undone.
      </p>
      <label>
        Type <b>{project.name}</b> to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus aria-label="Project name to confirm" />
      </label>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <ModalActions>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="danger" disabled={!matches || deleting}>
          {deleting ? "Deleting…" : "Delete project"}
        </button>
      </ModalActions>
    </Modal>
  );
}
