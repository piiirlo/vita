import * as ToastPrimitive from "@radix-ui/react-toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { dismissToast, TOAST_DURATION_MS, useToasts, type ToastKind } from "./toast.ts";

const ICONS: Record<ToastKind, typeof Info> = { success: CircleCheck, error: CircleAlert, info: Info };
const ICON_CLASS: Record<ToastKind, string> = { success: "text-success", error: "text-danger", info: "text-accent-text" };

/** Shows the toasts from toast.ts (bottom right). Hover pauses them; swipe right dismisses.
 * Errors use the danger color, an icon and the word "Error" (not color alone). */
export default function Toaster() {
  const toasts = useToasts();
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="Notifications">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <ToastPrimitive.Root
            key={t.id}
            duration={TOAST_DURATION_MS[t.kind]}
            type={t.kind === "error" ? "foreground" : "background"}
            onOpenChange={(open) => !open && dismissToast(t.id)}
            className={cn(
              "toast-root flex items-start gap-3 rounded-[16px] border bg-surface-raised py-3 pl-4 pr-2 text-sm text-text",
              "shadow-[0_18px_50px_-20px_var(--shadow)]",
              t.kind === "error" ? "border-danger-border" : "border-border-strong",
            )}
          >
            <Icon size={18} className={cn("mt-px shrink-0", ICON_CLASS[t.kind])} aria-hidden />
            <ToastPrimitive.Description className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {t.kind === "error" && <strong className="font-semibold text-danger">Error: </strong>}
              {t.message}
            </ToastPrimitive.Description>
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent p-0 text-muted hover:bg-hover hover:text-text"
            >
              <X size={16} aria-hidden />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[100] m-0 flex w-[min(420px,calc(100vw-32px))] list-none flex-col gap-2 p-0 outline-none max-md:bottom-[84px]" />
    </ToastPrimitive.Provider>
  );
}
