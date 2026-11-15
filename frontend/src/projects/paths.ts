/** Project-scoped URLs. Inside a project every page lives under /projects/:id (its
 * dashboards, charts, datasets, SQL Lab, connections); the old top-level URLs (/charts…)
 * still work and show every project's items. */
import { matchPath } from "react-router";
import { getCurrentProject } from "../api.ts";

const PREFIX = /^\/projects\/(\d+)(?=\/|$)/;

/** The project id in a URL path, or null. */
export function projectIdOf(pathname: string): number | null {
  const m = PREFIX.exec(pathname);
  return m ? Number(m[1]) : null;
}

/** The path inside the project: "/projects/3/charts/7" → "/charts/7" ("/" for the project page). */
export function innerPath(pathname: string): string {
  return pathname.replace(PREFIX, "") || "/";
}

/** A page path in the current project ("/charts" → "/projects/3/charts"); unchanged outside a
 * project. Reads the project ProjectProvider set for this render (see setCurrentProject). */
export function projectPath(path: string): string {
  const id = getCurrentProject();
  return id === null ? path : `/projects/${id}${path === "/" ? "" : path}`;
}

/** The project page itself. */
export const projectHome = (id: number) => `/projects/${id}`;

/** Which section of a project a path is in (for the rail and the breadcrumbs). */
export type ProjectSection = "home" | "dashboards" | "charts" | "datasets" | "sql-lab" | "connections" | "other";

export function sectionOf(inner: string): ProjectSection {
  if (inner === "/") return "home";
  for (const section of ["dashboards", "charts", "datasets", "sql-lab", "connections"] as const) {
    if (matchPath({ path: `/${section}`, end: false }, inner)) return section;
  }
  return "other";
}
