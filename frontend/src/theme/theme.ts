/** Light / dark / system theme. The preference is kept in localStorage ("vita.theme");
 * "system" follows the OS live. index.html applies the same logic before the first paint. */
import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "vita.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // storage blocked (private mode, sandbox): fall back to the OS setting
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

type Snapshot = { preference: ThemePreference; resolved: ResolvedTheme };

let snapshot: Snapshot = { preference: readPreference(), resolved: "light" };
snapshot = { ...snapshot, resolved: resolveTheme(snapshot.preference, systemPrefersDark()) };
const listeners = new Set<() => void>();

function apply(next: Snapshot) {
  const root = document.documentElement;
  const changed = root.getAttribute("data-theme") !== next.resolved;
  if (changed) {
    // Switch instantly: don't animate every color transition on the page.
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", next.resolved);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // not remembered, but still applied for this page
  }
  apply({ preference, resolved: resolveTheme(preference, systemPrefersDark()) });
}

/** The sun/moon button: switch to the opposite of what is shown now. */
export function toggleTheme(): void {
  setThemePreference(snapshot.resolved === "dark" ? "light" : "dark");
}

let watchingSystem = false;
function watchSystem() {
  if (watchingSystem || typeof window.matchMedia !== "function") return;
  watchingSystem = true;
  window.matchMedia(DARK_QUERY).addEventListener("change", (e) => {
    if (snapshot.preference === "system") apply({ ...snapshot, resolved: e.matches ? "dark" : "light" });
  });
}

function subscribe(listener: () => void) {
  watchSystem();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTheme(): Snapshot {
  return snapshot;
}

export function useTheme(): Snapshot & { setPreference(p: ThemePreference): void; toggle(): void } {
  const current = useSyncExternalStore(subscribe, getTheme);
  return { ...current, setPreference: setThemePreference, toggle: toggleTheme };
}

/** Make sure <html data-theme> matches the store (index.html normally did this already). */
export function initTheme(): void {
  apply({ ...snapshot });
}
