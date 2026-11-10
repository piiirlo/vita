import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { useState, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { buttonVariants, dialogContentClass, dialogOverlayClass } from "./ui/variants.ts";

type Props = {
  children: ReactNode;
  /** Saves; resolves true when saved (then the navigation goes on), false to stay on the page. */
  onSave(): Promise<boolean>;
  onDiscard(): void;
  onStay(): void;
};

/** "You have unsaved changes": Save / Discard / Stay. Escape and Stay keep you on the page; Stay
 * has focus so Enter never throws work away. */
export default function UnsavedChangesDialog({ children, onSave, onDiscard, onStay }: Props) {
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (!(await onSave())) setBusy(false);
    } catch {
      setBusy(false);
    }
  }

  return (
    <AlertDialogPrimitive.Root open onOpenChange={(open) => !open && onStay()}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className={dialogOverlayClass} />
        <AlertDialogPrimitive.Content aria-describedby={undefined} className={dialogContentClass}>
          <AlertDialogPrimitive.Title className="m-0 mb-3 border-0 p-0 text-lg font-semibold normal-case tracking-normal text-text">
            Unsaved changes
          </AlertDialogPrimitive.Title>
          <div className="text-[15px] leading-relaxed text-text [&_p]:my-1">{children}</div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button type="button" className={buttonVariants({ variant: "danger" })} onClick={onDiscard} disabled={busy}>
              Discard
            </button>
            <span className="flex-1" />
            <AlertDialogPrimitive.Cancel className={buttonVariants({ variant: "secondary" })} disabled={busy}>
              Stay
            </AlertDialogPrimitive.Cancel>
            {/* Not AlertDialog.Action: that would close the dialog before the save finishes. */}
            <button type="button" className={cn(buttonVariants({ variant: "primary" }))} onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
