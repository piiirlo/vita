import { Database, FileText, MoreHorizontal, Pencil, Plus, Table2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  createDashboard,
  listConnections,
  listDashboards,
  listDatasets,
  renameProject,
  type Connection,
  type DashboardListItem,
  type DatasetListItem,
} from "../api.ts";
import { toast } from "../components/toast.ts";
import { ErrorAlert } from "../components/ui/alert.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { SkeletonLines } from "../components/ui/skeleton.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";
import { errorText } from "../datasets/format.ts";
import DeleteProjectDialog from "../projects/DeleteProjectDialog.tsx";
import NameDialog from "../projects/NameDialog.tsx";
import { projectHome, projectPath } from "../projects/paths.ts";
import { useProject } from "../projects/projectContext.ts";
import { plural } from "../projects/text.ts";

const DB_NAMES = { postgresql: "PostgreSQL", mysql: "MySQL" } as const;

type Data = { dashboards: DashboardListItem[]; connections: Connection[]; datasets: DatasetListItem[] };

/** A project (the folder, opened): its dashboards and its data. */
export default function ProjectPage() {
  const ctx = useProject();
  const navigate = useNavigate();
  const project = ctx?.project ?? null;
  usePageTitle(project?.name ?? "Project");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"dashboard" | "rename" | "delete" | null>(null);

  useEffect(() => {
    Promise.all([listDashboards(), listConnections(), listDatasets()])
      .then(([dashboards, connections, datasets]) => setData({ dashboards, connections, datasets }))
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  if (!ctx) return null;
  if (ctx.error) return <ErrorAlert>{ctx.error}</ErrorAlert>;

  const connections = (data?.connections ?? []).filter((c) => !c.builtin);
  const files = (data?.datasets ?? []).filter((d) => d.is_upload);
  const datasets = (data?.datasets ?? []).filter((d) => !d.is_upload);
  const hasData = connections.length > 0 || (data?.datasets.length ?? 0) > 0;

  async function newDashboard(name: string) {
    const dashboard = await createDashboard({ name, description: null, layout: [], refresh_interval: "off" });
    setDialog(null);
    ctx?.reload();
    void navigate(projectPath(`/dashboards/${dashboard.id}`));
  }

  async function rename(name: string) {
    await renameProject(ctx!.id, name);
    setDialog(null);
    ctx?.reload();
    toast.success("Project renamed");
  }

  const setupPath = `${projectHome(ctx.id)}/setup`;
  const draft = project?.setup_draft ?? null;
  const getStarted = (
    <div className="get-started">
      <Link to={setupPath} className="button primary pill">
        {draft ? "Resume setup" : "Get started"}
      </Link>
    </div>
  );

  return (
    <div className="project-page">
      <header className="project-head">
        <span className="folder-icon" aria-hidden />
        <div className="project-title">
          <h1>{project?.name ?? "…"}</h1>
          {project && (
            <p>
              {plural(project.dashboard_count, "dashboard")} · {plural(project.dataset_count, "dataset")}
            </p>
          )}
        </div>
        {data && !hasData && (
          <Link to={setupPath} className="button primary pill">
            {draft ? "Resume setup" : "Connect data"}
          </Link>
        )}
        {project && (
          <DropdownMenu>
            <DropdownMenuTrigger className="icon" aria-label="Project actions">
              <MoreHorizontal size={18} aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDialog("rename")}>
                <Pencil size={16} className="text-muted" aria-hidden />
                Rename project
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("delete")}>
                <Trash2 size={16} className="text-muted" aria-hidden />
                Delete project…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      {error && <ErrorAlert>{error}</ErrorAlert>}
      {!data && !error && <SkeletonLines lines={3} label="Loading the project…" className="max-w-xl" />}
      {data && hasData && draft && (
        <p className="setup-resume" role="note">
          The setup isn't finished.
          <Link to={setupPath} className="button ghost pill small">
            Resume setup
          </Link>
        </p>
      )}

      {data && (
        <>
          <div className="project-section">
            <h2>Dashboards</h2>
            {hasData && (
              <button type="button" className="primary pill small" onClick={() => setDialog("dashboard")}>
                <Plus size={16} strokeWidth={2.4} aria-hidden />
                New dashboard
              </button>
            )}
          </div>
          <div className="dash-cards">
            {data.dashboards.map((d) => (
              <Link key={d.id} to={projectPath(`/dashboards/${d.id}`)} className="dash-card paper">
                <span className={`dash-thumb${d.chart_count ? "" : " empty"}`} aria-hidden>
                  {d.chart_count
                    ? Array.from({ length: Math.min(d.chart_count, 5) }, (_, j) => <span key={j} className={j === 0 ? "o" : j === 1 ? "w2" : ""} />)
                    : "Empty"}
                </span>
                <span>
                  <strong>{d.name}</strong>
                  <small>{plural(d.chart_count, "chart")}</small>
                </span>
              </Link>
            ))}
            {hasData ? (
              <button type="button" className="new-dash" onClick={() => setDialog("dashboard")}>
                <span className="plus-circle" aria-hidden>
                  <Plus size={20} strokeWidth={2.4} />
                </span>
                New dashboard
              </button>
            ) : (
              <div className="empty-dash">
                <strong>No data in this project yet</strong>
                Connect a database or upload a file to build your first chart.
                {getStarted}
              </div>
            )}
          </div>

          {(connections.length > 0 || data.datasets.length > 0) && (
            <>
              <div className="project-section">
                <h2>Data</h2>
              </div>
              <div className="data-sources">
                {connections.map((c) => (
                  <Link key={`c${c.id}`} to={projectPath(`/connections/${c.id}/browse`)} className="data-source">
                    <span className="data-icon" aria-hidden>
                      <Database size={20} />
                    </span>
                    <span>
                      <strong>
                        {c.name} · {DB_NAMES[c.db_type]}
                      </strong>
                      <small>Connected database</small>
                    </span>
                  </Link>
                ))}
                {files.map((d) => (
                  <Link key={`f${d.id}`} to={projectPath(`/datasets/${d.id}`)} className="data-source">
                    <span className="data-icon" aria-hidden>
                      <FileText size={20} />
                    </span>
                    <span>
                      <strong>{d.name}</strong>
                      <small>Uploaded file</small>
                    </span>
                  </Link>
                ))}
                {datasets.map((d) => (
                  <Link key={`d${d.id}`} to={projectPath(`/datasets/${d.id}`)} className="data-source">
                    <span className="data-icon" aria-hidden>
                      <Table2 size={20} />
                    </span>
                    <span>
                      <strong>{d.name}</strong>
                      <small>Dataset</small>
                    </span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {dialog === "dashboard" && project && (
        <NameDialog
          title="New dashboard"
          text={`Add it to ${project.name}.`}
          label="Dashboard name"
          submitLabel="Create dashboard"
          onSubmit={newDashboard}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "rename" && project && (
        <NameDialog
          title="Rename project"
          text="The project keeps everything in it."
          label="Project name"
          submitLabel="Rename"
          initial={project.name}
          onSubmit={rename}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && project && (
        <DeleteProjectDialog
          project={project}
          onCancel={() => setDialog(null)}
          onDeleted={() => {
            toast.success(`Deleted “${project.name}”`);
            void navigate("/");
          }}
        />
      )}
    </div>
  );
}
