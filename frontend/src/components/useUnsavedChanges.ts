import { useEffect, useRef } from "react";
import { useBlocker, type Blocker } from "react-router";

/**
 * Guards a page with unsaved changes: in-app navigation (links, the rail, the command palette,
 * browser back) is blocked so the page can ask Save / Discard / Stay (`UnsavedChangesDialog`),
 * and closing or reloading the tab gets the browser's own prompt. Needs a data router.
 *
 * `dirtyRef.current` is read at navigation time, so a page can clear it right before navigating
 * after a successful save (the re-render that would clear `dirty` hasn't happened yet).
 * Changes of only the query string never block.
 */
export function useUnsavedChanges(dirty: boolean): { blocker: Blocker; dirtyRef: { current: boolean } } {
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  return { blocker, dirtyRef };
}
