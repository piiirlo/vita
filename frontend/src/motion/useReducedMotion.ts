import { useSyncExternalStore } from "react";
import { onReducedMotionChange, prefersReducedMotion } from "./ignara.ts";

/** Whether the user prefers reduced motion (live). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(onReducedMotionChange, prefersReducedMotion, () => false);
}
