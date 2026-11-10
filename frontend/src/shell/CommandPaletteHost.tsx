import { lazy, Suspense, useEffect, useState } from "react";
import { isCommandPaletteOpen, setCommandPaletteOpen, useCommandPaletteOpen } from "./commandPaletteStore.ts";

// cmdk and the palette load the first time it opens (keeps them out of the main bundle).
const CommandPalette = lazy(() => import("./CommandPalette.tsx"));

/** Ctrl+K / Cmd+K anywhere (also inside Monaco and inputs) toggles the command palette. */
export default function CommandPaletteHost() {
  const open = useCommandPaletteOpen();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setCommandPaletteOpen(!isCommandPaletteOpen());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);

  if (!loaded) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette />
    </Suspense>
  );
}
