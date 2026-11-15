import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  getConnection,
  getDashboard,
  getSchemaDiagram,
  listConnections,
  listDatasets,
  saveSetupDraft,
  type Connection,
  type DatasetListItem,
  type SchemaDiagram,
} from "../api.ts";
import { toast } from "../components/toast.ts";
import { ErrorAlert } from "../components/ui/alert.tsx";
import { SkeletonLines } from "../components/ui/skeleton.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";
import { errorText } from "../datasets/format.ts";
import { projectHome, projectPath } from "../projects/paths.ts";
import { useCrumbTitle, useProject } from "../projects/projectContext.ts";
import { createQueryDataset, reuseUploadDataset } from "../setup/datasetFromQuery.ts";
import { ADD_CHART_STEPS, EMPTY_DRAFT, PROJECT_STEPS, readDraft, type SetupDraft } from "../setup/draft.ts";
import ExploreStep from "../setup/ExploreStep.tsx";
import { fileDiagram } from "../setup/fileDiagram.ts";
import QueryStep, { type QueryChoice } from "../setup/QueryStep.tsx";
import { marksFor } from "../setup/starterSql.ts";
import SourceStep from "../setup/SourceStep.tsx";
import WizardSteps from "../setup/WizardSteps.tsx";

const COPY = {
  source: { title: "Where does your data live?", lead: "Connect a database, or bring a file. You can add more later." },
  explore: {
    title: "Look around your data",
    lead: "Pick a table to see its columns. Mark which ones are dates and which ones you'll group by.",
  },
  query: {
    title: "Write your first query",
    lead: "Get the rows you want to chart. We wrote a starter query from what we found. Run it, or change it.",
  },
  addQuery: { title: "What data is this chart about?", lead: "Reuse a dataset from this project, or write a new query." },
} as const;

/** "Set up project" (4 steps: Connect data, Explore, Query, Chart) and a dashboard's "Add a
 * chart" (Query, Chart). The Chart step is the chart editor itself (all chart types), opened
 * with ?setup=1 / ?target=<dashboard>: saving there makes the chart and puts it on the
 * project's "Overview" dashboard (setup) or on that dashboard. */
export default function SetupPage({ mode }: { mode: "project" | "add" }) {
  const ctx = useProject();
  const navigate = useNavigate();
  const params = useParams();
  const dashboardId = mode === "add" ? Number(params.id) : null;
  const pageName = mode === "project" ? "Set up project" : "Add a chart";
  usePageTitle(pageName);
  useCrumbTitle(pageName);

  const steps = mode === "project" ? PROJECT_STEPS : ADD_CHART_STEPS;
  const [draft, setDraft] = useState<SetupDraft | null>(mode === "add" ? { ...EMPTY_DRAFT, step: "query" } : null);
  const [diagram, setDiagram] = useState<SchemaDiagram | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [dashboardName, setDashboardName] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<DatasetListItem[] | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [choice, setChoice] = useState<QueryChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new project starts empty; an unfinished one resumes where it was left.
  const project = ctx?.project ?? null;
  useEffect(() => {
    if (mode === "project" && draft === null && project) setDraft(readDraft(project.setup_draft) ?? EMPTY_DRAFT);
  }, [mode, draft, project]);

  // "Add a chart": the dashboard, the project's datasets and connections.
  useEffect(() => {
    if (dashboardId === null) return;
    Promise.all([getDashboard(dashboardId), listDatasets(), listConnections()])
      .then(([d, ds, cs]) => {
        setDashboardName(d.name);
        setDatasets(ds);
        setConnections(cs);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [dashboardId]);

  const connectionId = draft?.connectionId ?? null;
  useEffect(() => {
    if (connectionId === null) return setConnection(null);
    getConnection(connectionId)
      .then(setConnection)
      .catch(() => setConnection(null));
  }, [connectionId]);

  // Resumed on the Query step: the starter query needs the tables.
  const step = draft?.step ?? "source";
  useEffect(() => {
    if (mode !== "project" || step !== "query" || diagram || !draft?.table) return;
    const load =
      draft.source === "file" && draft.uploadDatasetId !== null
        ? fileDiagram(draft.uploadDatasetId).then((r) => r.diagram)
        : draft.connectionId !== null && draft.schema
          ? getSchemaDiagram(draft.connectionId, draft.schema)
          : null;
    load?.then(setDiagram).catch((err: unknown) => setError(errorText(err)));
  }, [mode, step, diagram, draft]);

  const update = useCallback((patch: Partial<SetupDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d)), []);

  if (!ctx) return null;
  if (error && !draft) return <ErrorAlert>{error}</ErrorAlert>;
  if (!draft || (mode === "add" && (!datasets || !connections))) {
    return <SkeletonLines lines={4} label="Loading…" className="max-w-xl" />;
  }

  const index = steps.indexOf(step);
  const copy = step === "query" && mode === "add" ? COPY.addQuery : COPY[step as keyof typeof COPY];

  async function saveDraft(next: SetupDraft, quiet = true) {
    if (mode !== "project") return;
    try {
      await saveSetupDraft(ctx!.id, next);
      ctx!.reload();
      if (!quiet) toast.success("Setup saved. Resume it from the project page.");
    } catch (err) {
      toast.error(`Couldn't save the setup: ${errorText(err)}`);
    }
  }

  function go(to: number) {
    const next = { ...draft!, step: steps[to]! };
    setDraft(next);
    setChoice(null);
    setError(null);
    if (to > index) void saveDraft(next);
  }

  /** Query → Chart: the dataset (made, reused or picked), then the chart editor. */
  async function buildChart() {
    if (!choice || !draft) return;
    setBusy(true);
    setError(null);
    try {
      let datasetId: number;
      if (choice.kind === "existing") datasetId = choice.datasetId;
      else if (draft.datasetId !== null && draft.datasetSql === choice.sql) datasetId = draft.datasetId;
      else if (draft.source === "file" && draft.uploadDatasetId !== null && choice.sql === choice.starterSql) {
        datasetId = (await reuseUploadDataset(draft.uploadDatasetId, choice.name, marksFor(draft, choice.starter))).id;
      } else {
        datasetId = (await createQueryDataset(choice.name, choice.connectionId, choice.sql, marksFor(draft, choice.starter))).id;
      }
      if (mode === "project") {
        await saveDraft({ ...draft, step: "chart", datasetId, datasetSql: choice.kind === "new" ? choice.sql : null });
        void navigate(projectPath(`/charts/new?dataset=${datasetId}&setup=1`));
      } else {
        void navigate(projectPath(`/charts/new?dataset=${datasetId}&target=${dashboardId}`));
      }
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const canNext =
    step === "source"
      ? draft.source === "db"
        ? draft.connectionId !== null
        : draft.source === "file" && draft.uploadDatasetId !== null
      : step === "explore"
        ? draft.table !== null
        : choice !== null && (choice.kind === "existing" || choice.name !== "");

  const leave = () => void navigate(mode === "project" ? projectHome(ctx.id) : projectPath(`/dashboards/${dashboardId}`));

  return (
    <div className="setup-page">
      <WizardSteps steps={steps} current={step} />
      <section className="setup-panel" aria-labelledby="setup-title">
        <h2 id="setup-title">{copy.title}</h2>
        <p className="lead">{copy.lead}</p>

        {step === "source" && <SourceStep draft={draft} onChange={update} />}
        {step === "explore" && <ExploreStep draft={draft} onChange={update} onDiagram={setDiagram} />}
        {step === "query" && (
          <QueryStep
            draft={draft}
            onChange={update}
            diagram={mode === "project" ? diagram : null}
            datasets={mode === "add" ? datasets! : undefined}
            connections={mode === "add" ? connections! : undefined}
            connectionName={connection?.name ?? "…"}
            dbType={connection?.db_type ?? "postgresql"}
            onReady={setChoice}
          />
        )}
        {error && <ErrorAlert className="mt-4">{error}</ErrorAlert>}

        <div className="setup-foot">
          <button type="button" className="ghost pill" onClick={() => (index === 0 ? leave() : go(index - 1))}>
            {index === 0 ? "Cancel" : "Back"}
          </button>
          <span className="spacer" />
          {mode === "project" && (
            <button type="button" className="ghost pill" onClick={() => void saveDraft(draft, false)}>
              Save as draft
            </button>
          )}
          {step === "query" && mode === "add" && dashboardName && <span className="muted small">The chart goes on “{dashboardName}”</span>}
          <button
            type="button"
            className="primary pill"
            disabled={!canNext || busy}
            onClick={() => (step === "query" ? void buildChart() : go(index + 1))}
          >
            {step === "query" ? (busy ? "Saving the dataset…" : "Build a chart") : "Continue"}
          </button>
        </div>
      </section>
    </div>
  );
}
