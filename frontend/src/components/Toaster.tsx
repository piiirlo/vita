import * as ToastPrimitive from "@radix-ui/react-toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { dismissToast, TOAST_DURATION_MS, useToasts, type ToastKind } from "./toast.ts";

const ICONS: Record<ToastKind, typeof Info> = { success: CircleCheck, error: CircleAlert, info: Info };
const ICON_CLASS: Record<ToastKind, string> = { success: "text-inverse-success", error: "text-inverse-danger", info: "text-inverse-info" };

/** Shows the toasts from toast.ts (bottom center, inverted like Ignara's). Hover pauses them; swipe right dismisses.
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
              "toast-root flex items-center gap-3 rounded-[15px] bg-inverse py-3 pl-4 pr-3 text-[13.5px] font-semibold text-inverse-fg",
              "shadow-[var(--shadow-lg)]",
              t.kind === "error" && "shadow-[inset_0_0_0_1.5px_var(--inverse-danger),var(--shadow-lg)]",
            )}
          >
            <Icon size={18} className={cn("mt-px shrink-0", ICON_CLASS[t.kind])} aria-hidden />
            <ToastPrimitive.Description className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {t.kind === "error" && <strong className="font-bold text-inverse-danger">Error: </strong>}
              {t.message}
            </ToastPrimitive.Description>
            {t.action && (
              <ToastPrimitive.Action
                altText={t.action.label}
                onClick={t.action.onClick}
                className="h-[30px] shrink-0 cursor-pointer rounded-[9px] border-0 bg-[var(--inverse-line)] px-3 text-[12.5px] font-bold text-inverse-fg hover:brightness-125"
              >
                {t.action.label}
              </ToastPrimitive.Action>
            )}
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="inline-flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[9px] border-0 bg-transparent p-0 text-inverse-muted hover:bg-[var(--inverse-line)] hover:text-inverse-fg"
            >
              <X size={16} aria-hidden />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed bottom-[22px] left-1/2 z-[100] m-0 flex w-[min(440px,calc(100vw-24px))] -translate-x-1/2 list-none flex-col gap-2 p-0 outline-none max-md:bottom-[96px]" />
    </ToastPrimitive.Provider>
  );
}
