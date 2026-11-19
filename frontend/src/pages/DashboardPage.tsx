import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpToLine, Plus, RefreshCw, Type } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  getCurrentProject,
  getDashboard,
  updateDashboard,
  type Dashboard,
  type DashboardChartInfo,
  type DashboardFilterDef,
  type FilterSelection,
  type DashboardTile,
  type RefreshInterval,
  type SavedChart,
} from "../api.ts";
import UnsavedChangesDialog from "../components/UnsavedChangesDialog.tsx";
import { useUnsavedChanges } from "../components/useUnsavedChanges.ts";
import { CACHE_TTLS } from "../charts/load.ts";
import { Button } from "../components/ui/button.tsx";
import { TitleText } from "../shell/PageHeader.tsx";
import { AuthContext } from "../auth/auth.ts";
import { motionOn } from "../motion/ignara.ts";
import AddChartDialog from "../dashboards/AddChartDialog.tsx";
import ChartTile from "../dashboards/ChartTile.tsx";
import DashboardGrid from "../dashboards/DashboardGrid.tsx";
import FilterBar from "../dashboards/FilterBar.tsx";
import FilterDialog from "../dashboards/FilterDialog.tsx";
import {
  FILTER_DEBOUNCE_MS,
  readCrossFilters,
  readFilterValues,
  toggleCross,
  withDefaults,
  writeCrossFilters,
  writeFilterValues,
  type CrossFilter,
} from "../dashboards/filters.ts";
import type { CrossSelection } from "../charts/crossSelect.ts";
import { tidyUp } from "../dashboards/gridTidy.ts";
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
import { projectPath } from "../projects/paths.ts";
import { useCrumbTitle } from "../projects/projectContext.ts";

type Draft = { name: string; layout: DashboardTile[]; filters: DashboardFilterDef[] };

const NO_FILTERS: DashboardFilterDef[] = [];
const NO_CROSS: CrossFilter[] = [];

export default function DashboardPage() {
  const dashboardId = Number(useParams().id);
  const [search, setSearch] = useSearchParams();

  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [addedCharts, setAddedCharts] = useState<Record<string, DashboardChartInfo>>({});
  const [addingChart, setAddingChart] = useState(false);
  // The filter being added (null inside) or edited; undefined = the dialog is closed.
  const [filterDialog, setFilterDialog] = useState<{ def: DashboardFilterDef | null } | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());

  usePageTitle(dashboard?.name ?? "Dashboard");
  useCrumbTitle(dashboard?.name);
  const narrow = useMediaQuery(NARROW_QUERY);
  const pageVisible = usePageVisible();
  const now = useNow(15_000);
  const auth = useContext(AuthContext);
  const user = auth?.state.status === "authenticated" ? auth.state.user.username : null;

  // One request queue and dataset cache per dashboard page.
  const queue = useRef(new RequestQueue(MAX_PARALLEL_TILES)).current;
  const datasets = useRef(new DatasetCache()).current;

  // ---------- filters ----------
  // Definitions: the draft's while editing. Values: the URL (f_<id>), else the saved defaults.
  const filterDefs = draft?.filters ?? dashboard?.filters ?? NO_FILTERS;
  const searchText = search.toString();
  const filterValues = useMemo(
    () => readFilterValues(new URLSearchParams(searchText), filterDefs),
    [searchText, filterDefs],
  );
  // Cross filters (a click on a chart element): ?xf=, only while cross-filtering is on.
  const crossOn = dashboard?.cross_filtering ?? false;
  const crossFilters = useMemo(
    () => (crossOn ? readCrossFilters(new URLSearchParams(searchText)) : NO_CROSS),
    [searchText, crossOn],
  );
  // Tiles reload a moment after the last change (typing a number, ticking several values).
  const valuesKey = JSON.stringify([filterValues, crossFilters]);
  const [debounced, setDebounced] = useState({ key: valuesKey, values: filterValues, cross: crossFilters });
  useEffect(() => {
    if (debounced.key === valuesKey) return;
    const timer = setTimeout(() => setDebounced({ key: valuesKey, values: filterValues, cross: crossFilters }), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [valuesKey, filterValues, crossFilters, debounced.key]);
  const filtersKey = `${JSON.stringify(filterDefs)}|${debounced.key}`;

  // Stable handlers for the tiles (react-router's setter changes with the location).
  const setSearchRef = useRef(setSearch);
  setSearchRef.current = setSearch;
  const onCrossSelect = useCallback((tile: string, selection: CrossSelection) => {
    setSearchRef.current((current) => writeCrossFilters(current, toggleCross(readCrossFilters(current), tile, selection)), { replace: true });
  }, []);
  const onCrossClear = useCallback((tile: string) => {
    setSearchRef.current((current) => writeCrossFilters(current, readCrossFilters(current).filter((f) => f.tile !== tile)), { replace: true });
  }, []);

  const context = useMemo<DashboardContextValue>(
    () => ({
      queue,
      datasets,
      dashboardId,
      refreshKey,
      cacheTtl: dashboard?.cache_ttl ?? null,
      filters: { defs: filterDefs, values: debounced.values, cross: debounced.cross },
      filtersKey,
      ...(crossOn && !draft ? { onCrossSelect, onCrossClear } : {}),
    }),
    // filtersKey stands for filterDefs and the debounced values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, datasets, dashboardId, refreshKey, dashboard?.cache_ttl, filtersKey, crossOn, draft === null],
  );

  function setFilterValue(id: string, selection: FilterSelection) {
    setSearch((current) => writeFilterValues(current, filterDefs, { ...readFilterValues(current, filterDefs), [id]: selection }), {
      replace: true,
    });
  }

  function resetFilters() {
    setSearch((current) => writeCrossFilters(writeFilterValues(current, filterDefs, readFilterValues(new URLSearchParams(), filterDefs)), []), {
      replace: true,
    });
  }

  async function setCrossFiltering(on: boolean) {
    const saved = await saveSettings({ cross_filtering: on }, "cross-filtering setting");
    if (saved && !on) setSearch((current) => writeCrossFilters(current, []), { replace: true });
  }

  async function saveFilterDefaults() {
    if (!dashboard) return;
    const saved = await saveSettings({ filters: withDefaults(dashboard.filters, filterValues) }, "default filter values");
    if (saved) {
      setSearch((current) => writeFilterValues(current, saved.filters, readFilterValues(current, saved.filters)), { replace: true });
      toast.success("Saved these filter values as the dashboard's defaults.");
    }
  }

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
      setDraft({ name: dashboard.name, layout: dashboard.layout, filters: dashboard.filters });
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("edit");
          return next;
        },
        { replace: true },
      );
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

  /** Saves the auto-refresh interval, the cache setting or the filters' defaults (outside edit
   * mode). Resolves the saved dashboard, or null when it failed. */
  async function saveSettings(
    patch: { refresh_interval?: RefreshInterval; cache_ttl?: number | null; filters?: DashboardFilterDef[]; cross_filtering?: boolean },
    what: string,
  ): Promise<Dashboard | null> {
    if (!dashboard) return null;
    try {
      const saved = await updateDashboard(dashboard.id, {
        name: dashboard.name,
        description: dashboard.description,
        layout: dashboard.layout,
        refresh_interval: dashboard.refresh_interval,
        cache_ttl: dashboard.cache_ttl,
        ...patch,
      });
      setDashboard(saved);
      return saved;
    } catch (err) {
      toast.error(`Couldn't save the ${what}: ${errorText(err)}`);
      return null;
    }
  }

  // ---------- editing ----------

  const dirty =
    dashboard !== null &&
    draft !== null &&
    (draft.name.trim() !== dashboard.name ||
      layoutKey(draft.layout) !== layoutKey(dashboard.layout) ||
      JSON.stringify(draft.filters) !== JSON.stringify(dashboard.filters));

  const { blocker, dirtyRef } = useUnsavedChanges(dirty);

  function edit() {
    if (!dashboard) return;
    setDraft({ name: dashboard.name, layout: dashboard.layout, filters: dashboard.filters });
  }

  function cancel() {
    setDraft(null);
    setAddedCharts({});
  }

  /** Add or replace a filter in the draft. A new filter starts from the current value of the
   * one it replaces only when its kind and column didn't change (FilterDialog decides). */
  function putFilter(def: DashboardFilterDef) {
    setDraft((d) => {
      if (!d) return d;
      const exists = d.filters.some((f) => f.id === def.id);
      return { ...d, filters: exists ? d.filters.map((f) => (f.id === def.id ? def : f)) : [...d.filters, def] };
    });
    setFilterDialog(undefined);
  }

  function removeFilter(def: DashboardFilterDef) {
    // Filters that depended on it no longer do.
    setDraft((d) =>
      d
        ? {
            ...d,
            filters: d.filters
              .filter((f) => f.id !== def.id)
              .map((f) => (f.depends_on?.includes(def.id) ? { ...f, depends_on: f.depends_on.filter((x) => x !== def.id) } : f)),
          }
        : d,
    );
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

  /** Resolves true when saved. */
  async function save(): Promise<boolean> {
    if (!dashboard || !draft) return false;
    if (!draft.name.trim()) {
      toast.error("Please enter a name for the dashboard.");
      return false;
    }
    setSaving(true);
    try {
      const saved = await updateDashboard(dashboard.id, {
        name: draft.name.trim(),
        description: dashboard.description,
        layout: draft.layout,
        refresh_interval: dashboard.refresh_interval,
        cache_ttl: dashboard.cache_ttl,
        filters: draft.filters,
      });
      setDashboard(saved);
      setDraft(null);
      setAddedCharts({});
      toast.success(`Saved "${saved.name}".`);
      dirtyRef.current = false;
      return true;
    } catch (err) {
      toast.error(`Couldn't save: ${errorText(err)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  // The charts on the dashboard (the filter dialog's "Applies to").
  const layoutForCharts = draft?.layout ?? dashboard?.layout;
  const filterCharts = useMemo(() => {
    const info = { ...dashboard?.charts, ...addedCharts };
    const ids = [...new Set((layoutForCharts ?? []).flatMap((t) => (t.type === "chart" ? [t.chart_id] : [])))];
    return ids.map((id) => ({ id, name: info[id]?.name ?? `Chart ${id}` }));
  }, [layoutForCharts, dashboard?.charts, addedCharts]);

  // ---------- render ----------

  if (loadError) {
    return (
      <div className="page-pad">
        <p className="alert alert-error">{loadError}</p>
        <Link to={projectPath("/dashboards")}>Back to dashboards</Link>
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
  const inProject = getCurrentProject() !== null;
  // "Add a chart": a dataset or new SQL, then the chart editor; the chart lands in the first
  // free spot of this dashboard.
  const addChartPath = projectPath(`/dashboards/${dashboard.id}/add-chart`);
  const charts = { ...dashboard.charts, ...addedCharts };

  // Every tile is a Paper card (big numbers too, with the hero layout); every tile enters
  // with a short stagger.
  const tileClass = (tile: DashboardTile) =>
    `dash-tile dash-tile-${tile.type} paper tile-enter${
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

  // Ignara's page head: a greeting, the big title, one line about the page, the date.
  const hour = new Date(now).getHours();
  const greeting = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${user ? `, ${user}` : ""}`;
  const chartCount = tiles.filter((t) => t.type === "chart").length;
  const summary =
    dashboard.description ||
    [`${chartCount} chart${chartCount === 1 ? "" : "s"}`, filterDefs.length ? `${filterDefs.length} filter${filterDefs.length === 1 ? "" : "s"}` : null, dashboard.cross_filtering ? "click a chart to filter the others" : null]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="dashboard-page">
      <header className="dash-header">
        <div className="dash-heading">
          {!editing && <span className="dash-greeting">{greeting}</span>}
          {/* In a project the breadcrumbs say where this is. */}
          {(!inProject || editing) && (
            <span className="eyebrow">
              {inProject ? (
                "Editing"
              ) : (
                <>
                  <Link to={projectPath("/dashboards")} className="crumb">
                    Dashboards
                  </Link>{" "}
                  / {editing ? "Editing" : "Space"}
                </>
              )}
            </span>
          )}
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
              <h1 className="dash-title" aria-label={motionOn() ? dashboard.name : undefined}>
                <TitleText key={dashboard.name} title={dashboard.name} />
              </h1>
            )}
            {dirty && <span className="dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />}
          </div>
        </div>
        <div className="dash-actions">
          {editing ? (
            <>
              <Button onClick={() => setAddingChart(true)}>
                <Plus size={16} aria-hidden /> Add chart
              </Button>
              <Button onClick={() => setLayout((ts) => addTextTile(ts))}>
                <Type size={16} aria-hidden /> Add text
              </Button>
              <Button
                variant="ghost"
                title="Pull every tile up, closing the gaps between them"
                onClick={() => setLayout((ts) => applyGridItems(ts, tidyUp(toGridItems(ts))))}
              >
                <ArrowUpToLine size={16} aria-hidden /> Tidy up
              </Button>
              <Button variant="ghost" onClick={cancel} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" className="magnetic" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={refreshAll}>
                <RefreshCw size={15} aria-hidden /> Refresh all
              </Button>
              <Button onClick={edit}>Edit</Button>
              <Link to={addChartPath} className="button primary pill magnetic">
                <Plus size={17} strokeWidth={2.4} aria-hidden /> Add a chart
              </Link>
            </>
          )}
        </div>
      </header>
      {!editing && <p className="dash-summary">{summary}</p>}
      {!editing && (
        <div className="dash-toolbar">
          <span
            className={`live-chip${intervalMs !== null ? " on" : ""}`}
            title={new Date(lastUpdated).toLocaleString()}
          >
            <span className={intervalMs !== null ? "live-dot" : "dot dot-ok"} aria-hidden />
            {intervalMs !== null && <span>Live ·</span>}
            <span>Last updated {relativeTime(new Date(lastUpdated).toISOString(), now)}</span>
          </span>
          <label className="inline-label small">
            Auto-refresh
            <select
              value={dashboard.refresh_interval}
              onChange={(e) => void saveSettings({ refresh_interval: e.target.value as RefreshInterval }, "refresh interval")}
              aria-label="Auto-refresh"
            >
              {REFRESH_INTERVALS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-label small">
            Cache
            <select
              value={dashboard.cache_ttl ?? ""}
              onChange={(e) =>
                void saveSettings({ cache_ttl: e.target.value === "" ? null : Number(e.target.value) }, "cache setting")
              }
              aria-label="Cache"
              title="How long tiles reuse a chart result (Refresh always queries again)"
            >
              <option value="">Each chart's own</option>
              {CACHE_TTLS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-label small cross-switch" title="Click a bar, slice, row… to filter the other charts on it">
            <input
              type="checkbox"
              role="switch"
              checked={dashboard.cross_filtering}
              onChange={(e) => void setCrossFiltering(e.target.checked)}
            />
            Cross-filter
          </label>
        </div>
      )}

      <FilterBar
        defs={filterDefs}
        values={filterValues}
        cross={crossFilters}
        crossSource={(tile) => {
          const spec = tiles.find((t) => t.id === tile);
          return spec?.type === "chart" ? (charts[spec.chart_id]?.name ?? null) : null;
        }}
        onCrossRemove={onCrossClear}
        editing={editing}
        datasets={datasets}
        onChange={setFilterValue}
        onReset={resetFilters}
        onSaveDefaults={() => void saveFilterDefaults()}
        onAdd={() => setFilterDialog({ def: null })}
        onEdit={(def) => setFilterDialog({ def })}
        onRemove={removeFilter}
      />

      <DashboardContext.Provider value={context}>
        {tiles.length === 0 ? (
          editing ? (
            <EmptyState title="This dashboard is empty">Use “Add chart” and “Add text” above.</EmptyState>
          ) : (
            <div className="empty-dash">
              <strong>This dashboard is empty</strong>
              Write a query or pick a dataset, then build your first chart.
              <div className="get-started">
                <Link to={addChartPath} className="button primary pill magnetic">
                  <Plus size={17} strokeWidth={2.4} aria-hidden /> Add a chart
                </Link>
              </div>
            </div>
          )
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
            items={toGridItems(tiles, (id) => charts[id]?.viz_type)}
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
      {filterDialog && (
        <FilterDialog
          initial={filterDialog.def}
          others={filterDefs.filter((f) => f.id !== filterDialog.def?.id)}
          charts={filterCharts}
          datasets={datasets}
          onSave={putFilter}
          onClose={() => setFilterDialog(undefined)}
        />
      )}

      {blocker.state === "blocked" && (
        <UnsavedChangesDialog
          onSave={async () => {
            const saved = await save();
            if (saved) blocker.proceed();
            return saved;
          }}
          onDiscard={() => blocker.proceed()}
          onStay={() => blocker.reset()}
        >
          <p>Your changes to this dashboard haven't been saved.</p>
        </UnsavedChangesDialog>
      )}
    </div>
  );
}
