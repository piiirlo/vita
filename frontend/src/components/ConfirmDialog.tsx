import { useState, type ReactNode } from "react";
import { AlertDialog } from "./ui/alert-dialog.tsx";
import { ErrorAlert } from "./ui/alert.tsx";

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
    <AlertDialog
      title={title}
      confirmLabel={confirmLabel}
      busy={busy}
      error={error && <ErrorAlert className="mt-4">{error}</ErrorAlert>}
      onConfirm={() => void confirm()}
      onCancel={onCancel}
    >
      {children}
    </AlertDialog>
  );
}
