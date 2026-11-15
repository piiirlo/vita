import { useState, type FormEvent } from "react";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";
import { errorText } from "../datasets/format.ts";

type Props = {
  title: string;
  /** One line under the title. */
  text: string;
  label: string;
  submitLabel: string;
  initial?: string;
  /** Rejecting shows the error in the dialog (e.g. "A project with that name already exists."). */
  onSubmit(name: string): Promise<void>;
  onCancel(): void;
};

/** Ask for a name: new project, new dashboard, rename (the prototype's dialog). */
export default function NameDialog({ title, text, label, submitLabel, initial = "", onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) {
      setError("Give it a name first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel} onSubmit={(e) => void submit(e)}>
      <p className="muted small m-0">{text}</p>
      <label>
        {label}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" autoFocus />
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
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </button>
      </ModalActions>
    </Modal>
  );
}
