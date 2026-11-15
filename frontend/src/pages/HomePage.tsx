import { Plus } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router";
import { createProject, listProjects, type Project } from "../api.ts";
import { ErrorAlert } from "../components/ui/alert.tsx";
import { SkeletonLines } from "../components/ui/skeleton.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";
import { errorText } from "../datasets/format.ts";
import NameDialog from "../projects/NameDialog.tsx";
import { projectHome } from "../projects/paths.ts";
import { plural, sourceLabel } from "../projects/text.ts";

// Where the dashboard "papers" sit in a folder: 1, 2 or 3 of them, fanned out.
const FAN: Record<number, { x: number; r: number; z: number }[]> = {
  1: [{ x: 0, r: 0, z: 1 }],
  2: [
    { x: -26, r: -5, z: 1 },
    { x: 26, r: 5, z: 2 },
  ],
  3: [
    { x: -44, r: -8, z: 1 },
    { x: 0, r: 0, z: 3 },
    { x: 44, r: 8, z: 2 },
  ],
};

/** Home: the projects, shown as folders (design/projects-prototype.html). */
export default function HomePage() {
  usePageTitle("Projects");
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  async function create(name: string) {
    const project = await createProject(name);
    setCreating(false);
    // A new project starts with its setup (Connect data, Explore, Query, Chart).
    void navigate(`${projectHome(project.id)}/setup`);
  }

  const dashboards = (projects ?? []).reduce((sum, p) => sum + p.dashboard_count, 0);

  return (
    <div className="projects-home">
      <header className="projects-head">
        <div>
          <h1>Your projects</h1>
          {projects && (
            <p>
              {plural(projects.length, "project")} · {plural(dashboards, "dashboard")}
            </p>
          )}
        </div>
        <button type="button" className="primary pill" onClick={() => setCreating(true)}>
          <Plus size={18} strokeWidth={2.4} aria-hidden />
          New project
        </button>
      </header>

      {error && <ErrorAlert>{error}</ErrorAlert>}
      {!projects && !error && <SkeletonLines lines={3} label="Loading projects…" className="max-w-xl" />}
      {projects && (
        <section className="folders" aria-label="Projects">
          {projects.map((p, i) => (
            <Folder key={p.id} project={p} index={i} onOpen={() => void navigate(projectHome(p.id))} />
          ))}
          <button type="button" className="new-tile" onClick={() => setCreating(true)}>
            <span className="plus-circle" aria-hidden>
              <Plus size={20} strokeWidth={2.4} />
            </span>
            New project
          </button>
        </section>
      )}

      {creating && (
        <NameDialog
          title="New project"
          text="Each project is a folder with its own data and dashboards."
          label="Project name"
          submitLabel="Create project"
          onSubmit={create}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}

/** A project as a folder. Hovering it fans its dashboards out; a paper (one dashboard) comes
 * to the front on hover or focus and opens that dashboard; anywhere else opens the project.
 * The folder is a wrapper (not a button) so the papers can be links of their own. */
function Folder({ project, index, onOpen }: { project: Project; index: number; onOpen(): void }) {
  const papers = project.dashboards.slice(0, 3);
  const fan = FAN[papers.length] ?? [];
  return (
    <div className="folder paper" style={{ animationDelay: `${index * 60}ms` }}>
      {/* The whole folder opens the project; papers sit above it and open their dashboard. */}
      <button
        type="button"
        className="folder-open"
        onClick={onOpen}
        aria-label={`${project.name}, ${plural(project.dashboard_count, "dashboard")}`}
      />
      <span className="folder-back" aria-hidden>
        <span className="folder-tab" />
      </span>
      <span className="folder-papers">
        {papers.length ? (
          papers.map((d, i) => (
            <Link
              key={d.id}
              to={`${projectHome(project.id)}/dashboards/${d.id}`}
              className="folder-paper"
              aria-label={`${d.name}, a dashboard in ${project.name}`}
              style={{ "--x": `${fan[i]!.x}px`, "--r": `${fan[i]!.r}deg`, "--z": fan[i]!.z } as CSSProperties}
            >
              <b>{d.name}</b>
              <span className="folder-mini" aria-hidden>
                <span className="o" />
                <span />
                <span className="w" />
              </span>
            </Link>
          ))
        ) : (
          <span className="folder-paper empty" aria-hidden style={{ "--x": "0px", "--r": "0deg" } as CSSProperties}>
            No dashboards yet
          </span>
        )}
      </span>
      <span className="folder-front" aria-hidden>
        <span className="folder-name">{project.name}</span>
        <span className="folder-row">
          <span>{plural(project.dashboard_count, "dashboard")}</span>
          <span className="folder-src">
            {project.sources.length > 0 && <i />}
            {sourceLabel(project.sources)}
          </span>
        </span>
      </span>
    </div>
  );
}
