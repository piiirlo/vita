import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { buttonVariants, dialogContentClass, dialogOverlayClass } from "./variants.ts";

type Props = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Shown inside the dialog (e.g. why a delete was refused). */
  error?: ReactNode;
  onConfirm(): void;
  onCancel(): void;
};

/** A confirmation that needs an explicit answer. Escape and Cancel cancel; Cancel has focus. */
export function AlertDialog({ title, children, confirmLabel, cancelLabel = "Cancel", busy, error, onConfirm, onCancel }: Props) {
  return (
    <AlertDialogPrimitive.Root open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className={dialogOverlayClass} />
        <AlertDialogPrimitive.Content aria-describedby={undefined} className={dialogContentClass}>
          <AlertDialogPrimitive.Title className="m-0 mb-3 border-0 p-0 text-lg font-semibold normal-case tracking-normal text-text">
            {title}
          </AlertDialogPrimitive.Title>
          <div className="text-[15px] leading-relaxed text-text [&_p]:my-1">{children}</div>
          {error}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialogPrimitive.Cancel className={buttonVariants({ variant: "secondary" })}>{cancelLabel}</AlertDialogPrimitive.Cancel>
            {/* Not AlertDialog.Action: that would close the dialog before onConfirm finishes. */}
            <button
              type="button"
              className={cn(buttonVariants({ variant: "danger" }), "font-semibold")}
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
