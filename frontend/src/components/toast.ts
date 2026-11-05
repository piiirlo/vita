/** App-wide toast notifications (one style everywhere). Call toast.success / toast.error /
 * toast.info from anywhere; <Toaster /> (in the app shell) shows them. */
import { useSyncExternalStore } from "react";

export type ToastKind = "success" | "error" | "info";
export type Toast = { id: number; kind: ToastKind; message: string };

const DURATION_MS: Record<ToastKind, number> = { success: 3000, info: 4000, error: 7000 };
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

function show(kind: ToastKind, message: string): number {
  const id = nextId++;
  // The same message twice in a row replaces the old one instead of stacking.
  toasts = [...toasts.filter((t) => t.message !== message), { id, kind, message }].slice(-MAX_TOASTS);
  emit();
  setTimeout(() => dismissToast(id), DURATION_MS[kind]);
  return id;
}

export const toast = {
  success: (message: string) => show("success", message),
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
