import { useState, type ReactNode } from "react";

type Props = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Throwing / rejecting shows the error in the dialog and keeps it open. */
  onConfirm(): Promise<void> | void;
  onCancel(): void;
};

/** An in-page confirmation (instead of window.confirm) with room for an error message. */
export default function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal card form"
        role="alertdialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2 className="modal-title">{title}</h2>
        <div className="confirm-body">{children}</div>
        {error && <p className="alert alert-error">{error}</p>}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
