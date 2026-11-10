import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Type } from "lucide-react";
import { Link, useBlocker, useParams, useSearchParams } from "react-router";
import {
  getDashboard,
  updateDashboard,
  type Dashboard,
  type DashboardChartInfo,
  type DashboardTile,
  type RefreshInterval,
  type SavedChart,
} from "../api.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { SearchCapsule } from "../shell/PageHeader.tsx";
import AddChartDialog from "../dashboards/AddChartDialog.tsx";
import ChartTile from "../dashboards/ChartTile.tsx";
import DashboardGrid from "../dashboards/DashboardGrid.tsx";
import { useMediaQuery, useNow, usePageVisible } from "../dashboards/hooks.ts";
import {
  addChartTile,
  addTextTile,
  applyGridItems,
  layoutKey,
  NARROW_QUERY,
  REFRESH_INTERVALS,
  refreshMs,
  stackOrder,
  tileHeight,
  toGridItems,
  type GridItem,
} from "../dashboards/layout.ts";
import { RequestQueue } from "../dashboards/queue.ts";
import TextTile from "../dashboards/TextTile.tsx";
import { DashboardContext, DatasetCache, MAX_PARALLEL_TILES, type DashboardContextValue } from "../dashboards/tileData.ts";
import { errorText, relativeTime } from "../datasets/format.ts";
import { usePageTitle } from "../components/usePageTitle.ts";
import { toast } from "../components/toast.ts";
import EmptyState from "../components/EmptyState.tsx";

type Draft = { name: string; layout: DashboardTile[] };

export default function DashboardPage() {
  const dashboardId = Number(useParams().id);
  const [search, setSearch] = useSearchParams();

  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [addedCharts, setAddedCharts] = useState<Record<string, DashboardChartInfo>>({});
  const [addingChart, setAddingChart] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());

  usePageTitle(dashboard?.name ?? "Dashboard");
  const narrow = useMediaQuery(NARROW_QUERY);
  const pageVisible = usePageVisible();
  const now = useNow(15_000);

  // One request queue and dataset cache per dashboard page.
  const queue = useRef(new RequestQueue(MAX_PARALLEL_TILES)).current;
  const datasets = useRef(new DatasetCache()).current;
  const context = useMemo<DashboardContextValue>(
    () => ({ queue, datasets, dashboardId, refreshKey }),
    [queue, datasets, dashboardId, refreshKey],
  );

  // ---------- loading ----------

  useEffect(() => {
    let cancelled = false;
    setDashboard(null);
    setLoadError(null);
    getDashboard(dashboardId)
      .then((d) => {
        if (cancelled) return;
        setDashboard(d);
        setLastUpdated(Date.now());
      })
      .catch((err: unknown) => !cancelled && setLoadError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [dashboardId]);

  // New dashboards open in edit mode (?edit=1).
  useEffect(() => {
    if (dashboard && search.get("edit") === "1") {
      setDraft({ name: dashboard.name, layout: dashboard.layout });
      setSearch({}, { replace: true });
    }
  }, [dashboard, search, setSearch]);

  // ---------- refreshing ----------

  const refreshAll = useCallback(() => {
    datasets.clear();
    setRefreshKey((k) => k + 1);
    setLastUpdated(Date.now());
  }, [datasets]);

  const editing = draft !== null;
  const intervalMs = dashboard ? refreshMs(dashboard.refresh_interval) : null;

  // Auto-refresh: due `intervalMs` after the last refresh, paused while the tab is hidden
  // (when it becomes visible again an overdue refresh runs at once) and while editing.
  useEffect(() => {
    if (intervalMs === null || !pageVisible || editing) return;
    const timer = setTimeout(refreshAll, Math.max(0, lastUpdated + intervalMs - Date.now()));
    return () => clearTimeout(timer);
  }, [intervalMs, pageVisible, editing, lastUpdated, refreshAll]);

  async function setRefreshInterval(value: RefreshInterval) {
    if (!dashboard) return;
    try {
      const saved = await updateDashboard(dashboard.id, {
        name: dashboard.name,
        description: dashboard.description,
        layout: dashboard.layout,
        refresh_interval: value,
      });
      setDashboard(saved);
    } catch (err) {
      toast.error(`Couldn't save the refresh interval: ${errorText(err)}`);
    }
  }

  // ---------- editing ----------

  const dirty =
    dashboard !== null &&
    draft !== null &&
    (draft.name.trim() !== dashboard.name || layoutKey(draft.layout) !== layoutKey(dashboard.layout));

  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function edit() {
    if (!dashboard) return;
    setDraft({ name: dashboard.name, layout: dashboard.layout });
  }

  function cancel() {
    setDraft(null);
    setAddedCharts({});
  }

  const setLayout = (update: (tiles: DashboardTile[]) => DashboardTile[]) =>
    setDraft((d) => {
      if (!d) return d;
      const layout = update(d.layout);
      return layout === d.layout ? d : { ...d, layout };
    });

  function addChart(chart: SavedChart) {
    setAddedCharts((c) => ({ ...c, [chart.id]: { id: chart.id, name: chart.name, viz_type: chart.viz_type } }));
    setLayout((tiles) => addChartTile(tiles, chart.id));
    setAddingChart(false);
  }

  async function save() {
    if (!dashboard || !draft) return;
    if (!draft.name.trim()) {
      toast.error("Please enter a name for the dashboard.");
      return;
    }
    setSaving(true);
    try {
      const saved = await updateDashboard(dashboard.id, {
        name: draft.name.trim(),
        description: dashboard.description,
        layout: draft.layout,
        refresh_interval: dashboard.refresh_interval,
      });
      setDashboard(saved);
      setDraft(null);
      setAddedCharts({});
      toast.success(`Saved "${saved.name}".`);
    } catch (err) {
      toast.error(`Couldn't save: ${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // ---------- render ----------

  if (loadError) {
    return (
      <div className="page-pad">
        <p className="alert alert-error">{loadError}</p>
        <Link to="/dashboards">Back to dashboards</Link>
      </div>
    );
  }
  // Same shape as the loaded page (header + tile grid), so nothing jumps when it arrives.
  if (!dashboard)
    return (
      <div className="dashboard-page" role="status" aria-label="Loading dashboard">
        <header className="dash-header">
          <div className="dash-heading">
            <span className="skeleton" style={{ width: 140, height: 12 }} />
            <span className="skeleton" style={{ width: 280, height: 34, marginTop: 6 }} />
          </div>
        </header>
        <div className="dash-loading-grid">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="skeleton" />
          ))}
        </div>
      </div>
    );

  const tiles = draft?.layout ?? dashboard.layout;
  const charts = { ...dashboard.charts, ...addedCharts };

  // Big numbers are the ink "hero" cards; every tile enters with a short stagger.
  const tileClass = (tile: DashboardTile) =>
    `dash-tile dash-tile-${tile.type} tile-enter${
      tile.type === "chart" && charts[tile.chart_id]?.viz_type === "big_number" ? " dash-tile-hero" : ""
    }`;

  const renderTile = (tile: DashboardTile) =>
    tile.type === "chart" ? (
      <ChartTile
        tile={tile}
        info={charts[tile.chart_id]}
        editing={editing}
        onRemove={() => setLayout((ts) => ts.filter((t) => t.id !== tile.id))}
      />
    ) : (
      <TextTile
        tile={tile}
        editing={editing}
        onChange={(text) => setLayout((ts) => ts.map((t) => (t.id === tile.id ? { ...t, text } : t)))}
        onRemove={() => setLayout((ts) => ts.filter((t) => t.id !== tile.id))}
      />
    );

  return (
    <div className="dashboard-page">
      <header className="dash-header">
        <div className="dash-heading">
          <span className="eyebrow">
            <Link to="/dashboards" className="crumb">
              Dashboards
            </Link>{" "}
            / {editing ? "Editing" : "Space"}
          </span>
          <div className="dash-title-row">
            {editing ? (
              <input
                className="chart-name-input dash-name-input"
                aria-label="Dashboard name"
                value={draft.name}
                maxLength={200}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            ) : (
              <h1 className="dash-title">{dashboard.name}</h1>
            )}
            {dirty && <span className="dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
          </div>
        </div>
        {!editing && <SearchCapsule className="dash-capsule" />}
        <div className="dash-actions">
          {editing ? (
            <>
              <Button onClick={() => setAddingChart(true)}>
                <Plus size={16} aria-hidden /> Add chart
              </Button>
              <Button onClick={() => setLayout((ts) => addTextTile(ts))}>
                <Type size={16} aria-hidden /> Add text
              </Button>
              <Button variant="ghost" onClick={cancel} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <>
              <span
                className={`live-chip${intervalMs !== null ? " on" : ""}`}
                title={new Date(lastUpdated).toLocaleString()}
              >
                <span className={intervalMs !== null ? "live-dot" : "dot dot-ok"} aria-hidden />
                {intervalMs !== null && <span>Live ·</span>}
                <span>Last updated {relativeTime(new Date(lastUpdated).toISOString(), now)}</span>
              </span>
              <Button onClick={refreshAll}>
                <RefreshCw size={15} aria-hidden /> Refresh all
              </Button>
              <label className="inline-label small">
                Auto-refresh
                <select
                  value={dashboard.refresh_interval}
                  onChange={(e) => void setRefreshInterval(e.target.value as RefreshInterval)}
                  aria-label="Auto-refresh"
                >
                  {REFRESH_INTERVALS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="primary" onClick={edit}>
                Edit
              </Button>
            </>
          )}
        </div>
      </header>
      {dashboard.description && !editing && <p className="muted dash-description">{dashboard.description}</p>}

      <DashboardContext.Provider value={context}>
        {tiles.length === 0 ? (
          <EmptyState title="This dashboard is empty">
            {editing ? "Use “Add chart” and “Add text” above." : "Click “Edit” to add charts and text."}
          </EmptyState>
        ) : narrow && !editing ? (
          <div className="dash-stack">
            {stackOrder(tiles).map((tile, index) => (
              <div
                key={tile.id}
                className={tileClass(tile)}
                data-enter={Math.min(index, 12)}
                style={tile.type === "chart" ? { height: Math.max(260, tileHeight(tile.h)) } : undefined}
              >
                {renderTile(tile)}
              </div>
            ))}
          </div>
        ) : (
          <DashboardGrid
            items={toGridItems(tiles)}
            editing={editing}
            onLayoutChange={(items: readonly GridItem[]) => setLayout((ts) => applyGridItems(ts, items))}
          >
            {tiles.map((tile, index) => (
              <div key={tile.id} className={tileClass(tile)} data-enter={Math.min(index, 12)}>
                {renderTile(tile)}
              </div>
            ))}
          </DashboardGrid>
        )}
      </DashboardContext.Provider>

      {addingChart && <AddChartDialog onPick={addChart} onClose={() => setAddingChart(false)} />}

      {blocker.state === "blocked" && (
        <ConfirmDialog
          title="Leave without saving?"
          confirmLabel="Leave"
          onConfirm={() => blocker.proceed?.()}
          onCancel={() => blocker.reset()}
        >
          <p>Your changes to this dashboard's layout haven't been saved.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
