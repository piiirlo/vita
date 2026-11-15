import { createContext, useContext, useEffect } from "react";
import type { Project } from "../api.ts";

export type ProjectContextValue = {
  id: number;
  /** null while loading (or when it couldn't be loaded: see `error`). */
  project: Project | null;
  error: string | null;
  /** Load the project again (after a rename, a new dashboard…). */
  reload(): void;
  /** The last breadcrumb (a dashboard's or a chart's name), set by the page. */
  crumb: string | null;
  setCrumb(title: string | null): void;
};

export const ProjectContext = createContext<ProjectContextValue | null>(null);

/** The project the page is in, or null outside one. */
export function useProject(): ProjectContextValue | null {
  return useContext(ProjectContext);
}

/** Show `title` as the last breadcrumb while the page is open (no-op outside a project, and
 * for undefined: a page shown inside another one leaves the crumb to it). */
export function useCrumbTitle(title: string | null | undefined) {
  const setCrumb = useContext(ProjectContext)?.setCrumb;
  useEffect(() => {
    if (!setCrumb || title === undefined) return;
    setCrumb(title?.trim() || null);
    return () => setCrumb(null);
  }, [setCrumb, title]);
}
