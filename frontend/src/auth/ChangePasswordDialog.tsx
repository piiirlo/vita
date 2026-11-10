import { useState, type FormEvent } from "react";
import { changePassword } from "../api.ts";
import { toast } from "../components/toast.ts";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";

const MIN_LENGTH = 8;

export default function ChangePasswordDialog({ onClose }: { onClose(): void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < MIN_LENGTH) {
      setError(`The new password must be at least ${MIN_LENGTH} characters long.`);
      return;
    }
    if (next !== repeat) {
      setError("The new passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast.success("Password changed. Other sessions were logged out.");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Change password" onClose={onClose} onSubmit={(e) => void submit(e)}>
      <label>
        Current password
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoFocus
        />
      </label>
      <label>
        New password
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <span className="muted small">At least {MIN_LENGTH} characters.</span>
      </label>
      <label>
        Repeat new password
        <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </label>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <ModalActions>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || !current || !next}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </ModalActions>
    </Modal>
  );
}
