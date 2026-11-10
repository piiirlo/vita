import { useState, type FormEvent } from "react";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";

type Props = {
  /** Dialog title; defaults to "Save query". */
  title?: string;
  initialName: string;
  initialDescription: string;
  onSave(name: string, description: string): Promise<void>;
  onCancel(): void;
};

export default function SaveDialog({ title = "Save query", initialName, initialDescription, onSave, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Please enter a name.");
      return;
    }
    setSaving(true);
    try {
      await onSave(name.trim(), description.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel} onSubmit={(e) => void submit(e)}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label>
        Description <span className="muted">(optional)</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </label>
      {error && <p className="alert alert-error">{error}</p>}
      <ModalActions>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </ModalActions>
    </Modal>
  );
}
