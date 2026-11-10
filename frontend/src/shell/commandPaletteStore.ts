/** Open / close state of the command palette, shared by Ctrl+K and the header search capsule. */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

export function setCommandPaletteOpen(next: boolean): void {
  open = next;
  for (const l of listeners) l();
}
export const openCommandPalette = () => setCommandPaletteOpen(true);
export const isCommandPaletteOpen = () => open;

export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}
