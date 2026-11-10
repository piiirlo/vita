import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { dialogContentClass, dialogOverlayClass } from "./variants.ts";


type ModalProps = {
  title: ReactNode;
  /** Called on Escape, the close button, or a click outside. */
  onClose(): void;
  children: ReactNode;
  /** Accessible name when the title isn't plain text. */
  label?: string;
  wide?: boolean;
  /** Render the content as a <form> (Enter submits). */
  onSubmit?(event: FormEvent<HTMLFormElement>): void;
  className?: string;
};

/** A modal dialog (rendered while mounted). Focus is trapped inside; Escape closes it. */
export function Modal({ title, onClose, children, label, wide, onSubmit, className }: ModalProps) {
  const body = (
    <>
      <div className="mb-4 flex items-start gap-3">
        <DialogPrimitive.Title className="m-0 flex-1 border-0 p-0 text-lg font-semibold normal-case tracking-normal text-text">
          {title}
        </DialogPrimitive.Title>
        <DialogPrimitive.Close
          className="-mr-2 -mt-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-transparent p-0 text-muted hover:bg-hover hover:text-text"
          aria-label="Close"
        >
          <X size={18} aria-hidden />
        </DialogPrimitive.Close>
      </div>
      {children}
    </>
  );
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={dialogOverlayClass} />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          aria-label={label}
          className={cn(dialogContentClass, wide && "w-[min(720px,calc(100vw-32px))]", className)}
          asChild={Boolean(onSubmit)}
        >
          {onSubmit ? (
            <form className="form" onSubmit={onSubmit}>
              {body}
            </form>
          ) : (
            <div className="form">{body}</div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The row of buttons at the bottom of a dialog. */
export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex flex-wrap items-center justify-end gap-2">{children}</div>;
}
