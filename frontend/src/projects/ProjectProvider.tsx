import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getProject, setCurrentProject, type Project } from "../api.ts";
import { errorText } from "../datasets/format.ts";
import { ProjectContext, type ProjectContextValue } from "./projectContext.ts";

/** Loads the project in the URL (null: no project) and makes it the current one: lists ask
 * only for its items, new items go in it, links stay in it. */
export default function ProjectProvider({ id, children }: { id: number | null; children: ReactNode }) {
  // Set during render, before the pages below render or fetch anything.
  setCurrentProject(id);
  useEffect(() => () => setCurrentProject(null), []);

  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crumb, setCrumb] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    setError(null);
    getProject(id)
      .then((p) => !cancelled && setProject(p))
      .catch((err: unknown) => {
        if (cancelled) return;
        setProject(null);
        setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo<ProjectContextValue | null>(
    () =>
      id === null
        ? null
        : { id, project: project?.id === id ? project : null, error, reload, crumb, setCrumb },
    [id, project, error, reload, crumb],
  );
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}
