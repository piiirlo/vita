import { useEffect } from "react";

/** Sets the browser tab title, e.g. "Sales overview · Vita". null/empty = just "Vita". */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title === undefined) return; // undefined: leave it (a page shown inside another)
    document.title = title ? `${title} · Vita` : "Vita";
  }, [title]);
}
