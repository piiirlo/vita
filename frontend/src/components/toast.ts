/** App-wide toast notifications (one style everywhere). Call toast.success / toast.error /
 * toast.info from anywhere; <Toaster /> (in the app shell) shows them. */
import { useSyncExternalStore } from "react";

export type ToastKind = "success" | "error" | "info";
/** An optional button in the toast, e.g. "Open dashboard". */
export type ToastAction = { label: string; onClick(): void };
export type Toast = { id: number; kind: ToastKind; message: string; action?: ToastAction };

/** How long each kind stays (Radix pauses the timer while hovered or focused). */
export const TOAST_DURATION_MS: Record<ToastKind, number> = { success: 3000, info: 4000, error: 7000 };
const MAX_TOASTS = 4;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function show(kind: ToastKind, message: string, action?: ToastAction): number {
  const id = nextId++;
  // The same message twice in a row replaces the old one instead of stacking.
  toasts = [...toasts.filter((t) => t.message !== message), { id, kind, message, ...(action ? { action } : {}) }].slice(-MAX_TOASTS);
  emit();
  return id;
}

export const toast = {
  success: (message: string, action?: ToastAction) => show("success", message, action),
  error: (message: string) => show("error", message),
  info: (message: string) => show("info", message),
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}

/** Tests: forget all toasts. */
export function clearToasts(): void {
  toasts = [];
  emit();
}
