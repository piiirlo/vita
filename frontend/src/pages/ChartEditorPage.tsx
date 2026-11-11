import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  ApiError,
  createChart,
  getChart,
  getDashboard,
  getDataset,
  isQueryErrorDetail,
  listDatasets,
  updateChart,
  type ChartDataResult,
  type ChartQuery,
  type Dataset,
  type DatasetListItem,
  type QueryErrorDetail,
  type SavedChart,
  type VizType,
} from "../api.ts";
import ChartControls from "../charts/ChartControls.tsx";
import { vizLabel } from "../charts/vizTypes.ts";
import ChartView from "../charts/ChartView.tsx";
import CustomizePanel from "../charts/CustomizePanel.tsx";
import { drawState } from "../charts/display.ts";
import { dataKey, loadChartData } from "../charts/load.ts";
import { seriesNamesOf } from "../charts/options.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import {
  adaptToViz,
  defaultQuery,
  fromParams,
  toParams,
  type ChartState,
  type DisplayOptions,
} from "../charts/model.ts";
import AddToDashboardDialog from "../dashboards/AddToDashboardDialog.tsx";
import type { SqlLabLocationState } from "../datasets/sqlLabLink.ts";
import ResultsPane, { type RunState } from "../sqllab/ResultsPane.tsx";
import SaveDialog from "../sqllab/SaveDialog.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";
import { toast } from "../components/toast.ts";
import EmptyState from "../components/EmptyState.tsx";
import UnsavedChangesDialog from "../components/UnsavedChangesDialog.tsx";
import { useUnsavedChanges } from "../components/useUnsavedChanges.ts";
import { relativeTime } from "../datasets/format.ts";

const AUTO_UPDATE_MS = 600;

/** Results remember the chart state they were made for, so a stale result is never drawn
 * as a different chart type while the new one loads. */
type Shown = {
  main: ChartDataResult;
  trend: ChartDataResult | null;
  compare: ChartDataResult | null;
  total: ChartDataResult | null;
  state: ChartState;
};
type Results =
  | { status: "idle" }
  | { status: "loading"; previous: Shown | null; startedAt: number }
  | ({ status: "done" } & Shown)
  | { status: "error"; error: QueryErrorDetail };

type Tab = "chart" | "data" | "sql";
type SideTab = "data" | "customize";

function asError(err: unknown): QueryErrorDetail {
  if (err instanceof ApiError && isQueryErrorDetail(err.detail)) return err.detail;
  return { kind: "other", message: err instanceof Error ? err.message : String(err), line: null, column: null };
}

/** What "unsaved changes" compares. */
const snapshot = (name: string, state: ChartState | null) =>
  state ? JSON.stringify({ name: name.trim(), viz: state.vizType, params: toParams(state) }) : "";

export default function ChartEditorPage() {
  const params = useParams();
  const chartId = params.id ? Number(params.id) : null;
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const [datasets, setDatasets] = useState<DatasetListItem[] | null>(null);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [state, setState] = useState<ChartState | null>(null);
  const [chart, setChart] = useState<SavedChart | null>(null);
  const [name, setName] = useState("");
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [results, setResults] = useState<Results>({ status: "idle" });
  const [tab, setTab] = useState<Tab>("chart");
  const [sideTab, setSideTab] = useState<SideTab>("data");
  const [saveDialog, setSaveDialog] = useState(false);
  // "Save" in the unsaved-changes dialog of a new chart: name it first, then leave.
  const [leaveAfterSaveAs, setLeaveAfterSaveAs] = useState(false);
  const [addToDashboard, setAddToDashboard] = useState(false);
  // Opened from a dashboard tile ("Edit chart"): link back to it.
  const fromDashboardId = Number(search.get("dashboard")) || null;
  const [fromDashboard, setFromDashboard] = useState<{ id: number; name: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  usePageTitle(chart?.name ?? (chartId === null ? "New chart" : "Chart"));

  // ---------- loading ----------

  useEffect(() => {
    listDatasets()
      .then(setDatasets)
      .catch((err: unknown) => setLoadError(asError(err).message));
  }, []);

  const startNew = useCallback((ds: Dataset) => {
    const initial = adaptToViz({ vizType: "table", query: defaultQuery(ds), display: {} }, "table", ds);
    setDataset(ds);
    setState(initial);
    // An untouched new chart has nothing to lose.
    setSavedSnapshot(snapshot("", initial));
  }, []);

  // Each load depends only on what it needs, so a late answer (e.g. the datasets list arriving
  // after the chart) never reloads the chart and throws away edits.
  useEffect(() => {
    if (chartId === null) return;
    let cancelled = false;
    setLoadError(null);
    getChart(chartId)
      .then(async (saved) => {
        const ds = await getDataset(saved.dataset_id);
        if (cancelled) return;
        const loaded = fromParams(saved.viz_type, saved.params, ds);
        setChart(saved);
        setDataset(ds);
        setState(loaded);
        setName(saved.name);
        setSavedSnapshot(snapshot(saved.name, loaded));
      })
      .catch((err: unknown) => !cancelled && setLoadError(asError(err).message));
    return () => {
      cancelled = true;
    };
  }, [chartId]);

  // A new chart starts on ?dataset=… or, without it, on the first dataset of the list.
  const newChartDatasetId = chartId !== null ? null : Number(search.get("dataset")) || (datasets?.[0]?.id ?? null);
  useEffect(() => {
    if (newChartDatasetId === null) return;
    let cancelled = false;
    setLoadError(null);
    getDataset(newChartDatasetId)
      .then((ds) => !cancelled && startNew(ds))
      .catch((err: unknown) => !cancelled && setLoadError(asError(err).message));
    return () => {
      cancelled = true;
    };
  }, [newChartDatasetId, startNew]);

  useEffect(() => {
    if (fromDashboardId === null) return;
    let cancelled = false;
    getDashboard(fromDashboardId)
      .then((d) => !cancelled && setFromDashboard({ id: d.id, name: d.name }))
      .catch(() => undefined); // just no link back
    return () => {
      cancelled = true;
    };
  }, [fromDashboardId]);

  // ---------- running ----------

  // Only what changes the data is in the key: display options redraw the loaded result.
  const requestKey = useMemo(() => (state ? dataKey(state) : ""), [state]);

  // refresh: skip the chart-data cache ("Update chart"); auto-updates may use it.
  const run = useCallback(async (refresh = false) => {
    if (!state) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setResults((prev) => ({
      status: "loading",
      startedAt: Date.now(),
      previous:
        prev.status === "done"
          ? { main: prev.main, trend: prev.trend, compare: prev.compare, total: prev.total, state: prev.state }
          : prev.status === "loading"
            ? prev.previous
            : null,
    }));
    try {
      const { main, trend, previous, total } = await loadChartData(state, current.signal, { refresh });
      if (controller.current === current) setResults({ status: "done", main, trend, compare: previous, total: total ?? null, state });
    } catch (err) {
      if (controller.current === current && !current.signal.aborted) setResults({ status: "error", error: asError(err) });
    }
  }, [state]);

  // Auto-update (debounced) whenever the query changes.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!requestKey) return;
    const timer = setTimeout(() => void runRef.current(), AUTO_UPDATE_MS);
    return () => clearTimeout(timer);
  }, [requestKey]);
  useEffect(() => () => controller.current?.abort(), []);

  // ---------- editing ----------

  const dirty = state !== null && snapshot(name, state) !== savedSnapshot;
  const { blocker, dirtyRef } = useUnsavedChanges(dirty);

  function setViz(viz: VizType) {
    if (state && dataset) setState(adaptToViz(state, viz, dataset));
  }
  function patchQuery(patch: Partial<ChartQuery>) {
    setState((s) => (s ? { ...s, query: { ...s.query, ...patch } } : s));
  }
  function patchDisplay(patch: Partial<DisplayOptions>) {
    setState((s) => (s ? { ...s, display: { ...s.display, ...patch } } : s));
  }
  async function switchDataset(id: number) {
    if (!state) return;
    try {
      const ds = await getDataset(id);
      setDataset(ds);
      setState(adaptToViz({ vizType: state.vizType, query: defaultQuery(ds), display: state.display }, state.vizType, ds));
    } catch (err) {
      setLoadError(asError(err).message);
    }
  }

  // ---------- saving ----------

  async function saveAs(newName: string, description: string) {
    if (!state) return;
    const created = await createChart({
      name: newName,
      description: description || null,
      viz_type: state.vizType,
      params: toParams(state),
    });
    setSaveDialog(false);
    setChart(created);
    setName(created.name);
    setSavedSnapshot(snapshot(created.name, state));
    toast.success(`Saved "${created.name}".`);
    dirtyRef.current = false; // saved: navigating on is fine (before the re-render says so)
    if (leaveAfterSaveAs) {
      setLeaveAfterSaveAs(false);
      blocker.proceed?.();
      return;
    }
    void navigate(`/charts/${created.id}`, { replace: chartId === null });
  }

  /** Resolves true when saved. A new chart asks for a name first (and resolves false). */
  async function save(): Promise<boolean> {
    if (!state) return false;
    if (!chart) {
      setSaveDialog(true);
      return false;
    }
    try {
      const updated = await updateChart(chart.id, {
        name: name.trim() || chart.name,
        description: chart.description,
        viz_type: state.vizType,
        params: toParams(state),
      });
      setChart(updated);
      setName(updated.name);
      setSavedSnapshot(snapshot(updated.name, state));
      toast.success(`Saved "${updated.name}".`);
      dirtyRef.current = false;
      return true;
    } catch (err) {
      toast.error(`Couldn't save: ${asError(err).message}`);
      return false;
    }
  }

  async function saveAndLeave(): Promise<boolean> {
    if (!chart) {
      // Name it first; saveAs() then lets the navigation through (Cancel stays here).
      setLeaveAfterSaveAs(true);
      setSaveDialog(true);
      return false;
    }
    const saved = await save();
    if (saved) blocker.proceed?.();
    return saved;
  }

  // ---------- render ----------

  if (loadError) {
    return (
      <div className="page-pad">
        <p className="alert alert-error">{loadError}</p>
        <Link to="/charts">Back to charts</Link>
      </div>
    );
  }
  if (datasets !== null && datasets.length === 0 && chartId === null) {
    return (
      <div className="page-pad">
        <EmptyState
          title="Charts are built on datasets. Create a dataset first."
          action={
            <Link to="/datasets/new" className="button primary">
              New dataset
            </Link>
          }
        />
      </div>
    );
  }
  if (!state || !dataset || !datasets) return <p className="muted page-pad">Loading…</p>;

  const shown = results.status === "done" ? results : results.status === "loading" ? results.previous : null;
  const runState: RunState | undefined =
    results.status === "loading"
      ? { status: "running", startedAt: results.startedAt, previous: results.previous?.main ?? null }
      : results.status === "done"
        ? { status: "done", result: results.main }
        : results.status === "error"
          ? { status: "error", error: results.error }
          : undefined;
  const shownSeriesNames = shown ? seriesNamesOf(shown.state, shown.main, dataset) : [];
  const sqls = shown ? [shown.main.sql, ...(shown.trend ? [shown.trend.sql] : [])] : [];
  const typeLabel = vizLabel(state.vizType);

  return (
    <div className="chart-editor">
      <aside className="chart-editor-side">
        {/* Data: what to query (debounced auto-update). Customize: the look, redrawn from the
            loaded data without a new query. */}
        <Tabs value={sideTab} onValueChange={(v) => setSideTab(v as SideTab)} className="chart-side-tabs">
          <TabsList aria-label="Chart settings" className="mx-1.5 mb-2.5 grid grid-cols-2 [&>button]:w-full">
            <TabsTrigger value="data">Data</TabsTrigger>
            <TabsTrigger value="customize">Customize</TabsTrigger>
          </TabsList>
          <TabsContent value="data">
            <ChartControls
              state={state}
              dataset={dataset}
              datasets={datasets}
              onDataset={(id) => void switchDataset(id)}
              onVizType={setViz}
              onQuery={patchQuery}
              onDisplay={patchDisplay}
            />
          </TabsContent>
          <TabsContent value="customize">
            <CustomizePanel
              state={state}
              dataset={dataset}
              seriesNames={shownSeriesNames}
              onDisplay={patchDisplay}
              onQuery={patchQuery}
            />
          </TabsContent>
        </Tabs>
      </aside>

      <section className="chart-editor-main">
        <div className="chart-editor-header">
          <Link to="/charts" className="crumb">
            Charts
          </Link>
          <span className="crumb">/</span>
          {chart ? (
            <input className="chart-name-input" aria-label="Chart name" value={name} onChange={(e) => setName(e.target.value)} />
          ) : (
            <span className="chart-name">New {typeLabel.toLowerCase()} chart</span>
          )}
          {dirty && <span className="dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
          <span className="spacer" />
          {fromDashboard && (
            <Link to={`/dashboards/${fromDashboard.id}`} className="back-link">
              ← Back to {fromDashboard.name}
            </Link>
          )}
          <button onClick={() => void run(true)} disabled={results.status === "loading"} title="Run the chart query now (skips the cache)">
            Update chart
          </button>
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
          {chart && <button onClick={() => setSaveDialog(true)}>Save as new</button>}
          {chart && (
            <button onClick={() => setAddToDashboard(true)} title="Add this saved chart to a dashboard">
              Add to dashboard
            </button>
          )}
        </div>

        <div className="dataset-tabs chart-tabs" role="tablist">
          {(["chart", "data", "sql"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "chart" ? "Chart" : t === "data" ? "Results" : "SQL"}
            </button>
          ))}
          <span className="spacer" />
          {shown && (
            <span className="muted small">
              {shown.main.row_count.toLocaleString()} row{shown.main.row_count === 1 ? "" : "s"}
              {shown.main.truncated ? " (row limit reached)" : ""} · {shown.main.duration_ms} ms
              {shown.main.cached_at && (
                <span title="From the chart-data cache; Update chart runs the query again">
                  {" "}
                  · cached {relativeTime(shown.main.cached_at)}
                </span>
              )}
            </span>
          )}
        </div>

        {tab === "chart" && (
          <div className="chart-canvas">
            {results.status === "error" && (
              <div className="alert alert-error chart-error" role="alert">
                {results.error.message}
              </div>
            )}
            {results.status === "loading" && (
              <div className="chart-loading" role="status">
                <span className="live-dot" aria-hidden /> Updating…
              </div>
            )}
            {shown && results.status !== "error" && state.display.title?.trim() && (
              <h2 className="chart-preview-title">{state.display.title.trim()}</h2>
            )}
            {shown && results.status !== "error" && (
              <ChartView
                state={drawState(shown.state, state)}
                result={shown.main}
                trend={shown.trend}
                previous={shown.compare}
                total={shown.total}
                showHints
                dataset={dataset}
                onMakeHorizontal={() => patchDisplay({ horizontal: true })}
                onShowAllTime={() => {
                  const time = state.query.time;
                  if (time) patchQuery({ time: { ...time, range: { kind: "none" } } });
                }}
              />
            )}
            {results.status === "idle" && <p className="chart-empty muted">Pick what to show on the left.</p>}
          </div>
        )}
        {tab === "data" && (
          <div className="chart-data">
            <ResultsPane run={runState} title={name || "chart"} onStop={() => controller.current?.abort()} />
          </div>
        )}
        {tab === "sql" && (
          <div className="chart-sql">
            {sqls.length === 0 && <p className="muted">Run the chart to see its SQL.</p>}
            {sqls.map((sql, i) => (
              <div key={i}>
                {sqls.length > 1 && <h3 className="small muted">{i === 0 ? "Value" : "Trend line"}</h3>}
                <pre className="mono small">{sql}</pre>
              </div>
            ))}
            {sqls.length > 0 && (
              <button
                onClick={() => {
                  const location: SqlLabLocationState = {
                    openTab: { title: name || `${typeLabel} chart`, sql: sqls[0]!, connectionId: dataset.connection_id, schema: null },
                  };
                  void navigate("/sql-lab", { state: location });
                }}
              >
                Open in SQL Lab
              </button>
            )}
          </div>
        )}
      </section>

      {addToDashboard && chart && (
        <AddToDashboardDialog chartId={chart.id} chartName={chart.name} onClose={() => setAddToDashboard(false)} />
      )}

      {saveDialog && (
        <SaveDialog
          title={chart ? "Save chart as new" : "Save chart"}
          initialName={chart ? `${chart.name} (copy)` : ""}
          initialDescription={chart?.description ?? ""}
          onSave={saveAs}
          onCancel={() => {
            setSaveDialog(false);
            if (leaveAfterSaveAs) {
              setLeaveAfterSaveAs(false);
              blocker.reset?.();
            }
          }}
        />
      )}

      {blocker.state === "blocked" && !saveDialog && (
        <UnsavedChangesDialog onSave={saveAndLeave} onDiscard={() => blocker.proceed()} onStay={() => blocker.reset()}>
          <p>{chart ? `Your changes to "${chart.name}" haven't been saved.` : "This new chart hasn't been saved yet."}</p>
        </UnsavedChangesDialog>
      )}
    </div>
  );
}
