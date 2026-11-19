import { Component, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Clock, Filter, Flame, TrendingUp } from "lucide-react";
import { Link } from "react-router";
import {
  isSqlMetric,
  type ChartDataResult,
  type ChartTileSpec,
  type DashboardChartInfo,
  type Dataset,
  type MetricRef,
  type QueryErrorDetail,
  type RangeKind,
} from "../api.ts";
import { CountUp } from "../components/motion.tsx";
import { metricFormatter } from "../charts/display.ts";
import { categoryLabel, toNumber } from "../charts/format.ts";
import { kpiStyle } from "../charts/kpi.ts";
import { metricName, type ChartState } from "../charts/model.ts";
import { QueryErrorBody } from "../components/QueryErrorAlert.tsx";
import { toQueryError } from "../components/queryError.ts";
import ChartView from "../charts/ChartView.tsx";
import { errorText, relativeTime } from "../datasets/format.ts";
import { csvFilename, downloadCsv, toCsv } from "../sqllab/results.ts";
import { useInView } from "./hooks.ts";
import { CancelledError, type QueuedTask } from "./queue.ts";
import { DashboardContext, loadTileData, type TileData } from "./tileData.ts";
import TileMenu from "./TileMenu.tsx";
import { filterLabel } from "./filters.ts";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";
import { projectPath } from "../projects/paths.ts";

type Props = {
  tile: ChartTileSpec;
  info: DashboardChartInfo | undefined;
  editing: boolean;
  onRemove(): void;
};

/** A chart on a dashboard. Loads on its own (through the dashboard's request queue) and
 * shows its own loading / "No data" / error state. */
export default function ChartTile({ tile, info, editing, onRemove }: Props) {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("ChartTile must be inside a dashboard");
  const { queue, datasets, refreshKey, dashboardId, cacheTtl, filters, filtersKey, onCrossSelect, onCrossClear } = ctx;
  const crossing = filters.cross?.find((f) => f.tile === tile.id);
  // The first load may use the chart-data cache; every reload after it (Refresh, Refresh all,
  // auto-refresh) asks for fresh data. A filter change may use the cache.
  const loadedOnce = useRef(false);
  const cacheTtlRef = useRef(cacheTtl);
  cacheTtlRef.current = cacheTtl;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const lastReload = useRef<string | null>(null);

  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const inViewRef = useRef(inView);
  inViewRef.current = inView;
  const task = useRef<QueuedTask<TileData> | null>(null);

  const [data, setData] = useState<TileData | null>(null);
  const [error, setError] = useState<QueryErrorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [ownRefresh, setOwnRefresh] = useState(0);
  const [showSql, setShowSql] = useState(false);
  // The tile's range switch (Ignara's 14 days / 30 days / 13 weeks): null = the chart's own.
  const [range, setRange] = useState<RangeKind | null>(null);

  const measured = inView !== null;
  useEffect(() => {
    if (!measured) return; // wait until we know whether the tile is on screen
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    const reload = `${refreshKey}:${ownRefresh}`;
    const refresh = loadedOnce.current && reload !== lastReload.current;
    lastReload.current = reload;
    const queued = queue.schedule(
      () => loadTileData(tile.chart_id, datasets, controller.signal, { cacheTtl: cacheTtlRef.current, refresh }, filtersRef.current, tile.id, range),
      inViewRef.current === true,
    );
    task.current = queued;
    queued.promise.then(
      (loaded) => {
        if (cancelled) return;
        loadedOnce.current = true;
        setData(loaded);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled || err instanceof CancelledError) return;
        loadedOnce.current = true; // Retry / Refresh after an error query fresh too
        setError(toQueryError(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      queued.cancel();
      controller.abort();
    };
  }, [measured, queue, datasets, tile.chart_id, tile.id, refreshKey, ownRefresh, filtersKey, range]);

  useEffect(() => {
    if (inView) task.current?.setVisible(true);
  }, [inView]);

  // The chart's own title (Customize) wins over its name.
  const name = data?.state.display.title?.trim() || data?.chart.name || info?.name || "Chart";
  const sqls = data ? [data.main.sql, ...(data.trend ? [data.trend.sql] : [])] : [];
  const kpi = (data?.state.vizType ?? info?.viz_type) === "big_number" ? (data ? kpiStyle(data.state.display) : "card") : null;
  const subtitle = data?.chart.description?.trim() || null;
  const cachedText = data
    ? data.main.cached_at
      ? `cached ${relativeTime(data.main.cached_at)}`
      : `query ${data.main.duration_ms} ms · refreshed ${relativeTime(new Date(data.loadedAt).toISOString())}`
    : null;
  const timeFiltered = data?.filteredBy.some((f) => f.kind === "time") ?? false;

  return (
    <div className={`dash-tile-inner${kpi ? ` kpi-tile kpi-tile-${kpi}` : ""}`} ref={ref} data-testid={`tile-${tile.id}`}>
      <div className={`dash-tile-header${editing ? " dash-drag-handle" : ""}${kpi && kpi !== "classic" ? " kpi-head" : ""}`}>
        {kpi && kpi !== "classic" && (kpi === "hero" ? <Flame size={17} className="kpi-icon" aria-hidden /> : <TrendingUp size={17} className="kpi-icon" aria-hidden />)}
        <span className="dash-tile-heading">
          <span className="dash-tile-title" title={name}>
            {name}
          </span>
          {subtitle && !kpi && (
            <span className="dash-tile-sub" title={subtitle}>
              {subtitle}
            </span>
          )}
        </span>
        {data && data.filteredBy.length > 0 && (
          <span
            className="tile-filtered"
            data-testid="tile-filtered"
            role="img"
            title={`Filtered by ${data.filteredBy.map(filterLabel).join(", ")}`}
            aria-label={`Filtered by ${data.filteredBy.map(filterLabel).join(", ")}`}
          >
            <Filter size={12} aria-hidden />
          </span>
        )}
        {crossing && !editing && (
          <span className="tile-crossing pop-in" data-testid="tile-crossing">
            Filtering
            {onCrossClear && (
              <button type="button" onClick={() => onCrossClear(tile.id)} aria-label={`Stop filtering by ${name}`} title="Stop filtering the other charts">
                ×
              </button>
            )}
          </span>
        )}
        {loading && data && <span className="live-dot" role="status" aria-label="Refreshing" />}
        <span className="spacer" />
        {data && data.notFilteredBy.length > 0 && (
          <span className="tile-unfiltered" data-testid="tile-unfiltered">
            Not filtered by {data.notFilteredBy.map(filterLabel).join(", ")}
          </span>
        )}
        {!loading && data?.main.cached_at && data.state.vizType !== "big_number" && (
          <span
            className="tile-cached"
            tabIndex={0}
            title={`${cachedText ?? ""}: from the chart-data cache; Refresh queries again`}
            data-testid="tile-cached"
          >
            <Clock size={13} aria-hidden />
            <span className="sr-only">cached {relativeTime(data.main.cached_at)}</span>
          </span>
        )}
        {!editing && !kpi && (
          <Link to={projectPath(`/charts/${tile.chart_id}?dashboard=${dashboardId}`)} className="tile-open" aria-label={`Open ${name}`} title="Open the chart">
            <ArrowUpRight size={16} aria-hidden />
          </Link>
        )}
        {!editing && (
          <TileMenu
            label={`Menu for ${name}`}
            items={[
              { label: "Refresh", onSelect: () => setOwnRefresh((k) => k + 1) },
              { label: "View SQL", onSelect: () => setShowSql(true), disabled: !data },
              {
                label: "Download CSV",
                disabled: !data,
                onSelect: () => data && downloadCsv(csvFilename(name), toCsv(data.main.columns.map((c) => c.name), data.main.rows)),
              },
              { label: "Edit chart", to: projectPath(`/charts/${tile.chart_id}?dashboard=${dashboardId}`) },
            ]}
          />
        )}
        {editing && (
          <button className="icon small" onClick={onRemove} aria-label={`Remove ${name}`} title="Remove from dashboard">
            ×
          </button>
        )}
      </div>

      <div className="dash-tile-body" title={data ? `Updated ${relativeTime(new Date(data.loadedAt).toISOString())}` : undefined}>
        {error ? (
          <div className="dash-tile-error" role="alert">
            <div className="mb-2">
              <strong className="font-semibold text-danger">Error: </strong>
              <QueryErrorBody error={error} />
            </div>
            <button className="small" onClick={() => setOwnRefresh((k) => k + 1)}>
              Retry
            </button>
          </div>
        ) : data ? (
          <TileErrorBoundary key={data.loadedAt}>
            {!editing && (
              <TileFigures
                state={data.state}
                result={data.main}
                dataset={data.dataset}
                range={timeFiltered ? null : (range ?? data.state.query.time?.range.kind ?? null)}
                onRange={timeFiltered ? null : setRange}
              />
            )}
            <ChartView
              state={data.state}
              result={data.main}
              trend={data.trend}
              previous={data.previous}
              total={data.total}
              dataset={data.dataset}
              onSelect={onCrossSelect && !editing ? (selection) => onCrossSelect(tile.id, selection) : undefined}
            />
            {data.state.vizType === "big_number" && (
              <div className="hero-meta">
                {loading ? (
                  <span className="scan-line" aria-hidden data-testid="hero-loading-line" />
                ) : (
                  <span className="hero-rule" aria-hidden>
                    {/* Keyed by load time: runs once per new value, then it's gone. */}
                    <span key={data.loadedAt} className="hero-sweep" data-testid="hero-sweep" />
                  </span>
                )}
                <span className="hero-meta-text" tabIndex={0} title={cachedText ?? undefined}>
                  <Clock size={12} aria-hidden />
                  <span className="sr-only">{cachedText}</span>
                </span>
              </div>
            )}
          </TileErrorBoundary>
        ) : (
          <TileSkeleton viz={info?.viz_type} />
        )}
      </div>

      {showSql && (
        <Modal title={<>SQL of “{name}”</>} onClose={() => setShowSql(false)} wide label={`SQL of ${name}`}>
          {sqls.map((sql, i) => (
            <div key={i}>
              {sqls.length > 1 && <h3 className="small muted">{i === 0 ? "Value" : "Trend line"}</h3>}
              <pre className="mono small sql-block">{sql}</pre>
            </div>
          ))}
          <ModalActions>
            <button type="button" onClick={() => setShowSql(false)} autoFocus>
              Close
            </button>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}

const RANGES: [RangeKind, string][] = [
  ["last_7_days", "7 days"],
  ["last_30_days", "30 days"],
  ["last_90_days", "90 days"],
  ["last_12_months", "12 months"],
];

const GRAIN_WORD: Record<string, string> = { day: "day", week: "week", month: "month", quarter: "quarter", year: "year", raw: "point" };

/** A total is a sum only for sums and counts; anything else gets an average. */
function additive(metric: MetricRef, dataset: Dataset | null): boolean {
  const sumLike = (sql: string) => /^\s*(sum|count)\s*\(/i.test(sql) && !/\bdistinct\b/i.test(sql);
  if (typeof metric === "string") {
    const saved = dataset?.metrics.find((m) => m.name === metric);
    return saved ? sumLike(saved.expression) : false;
  }
  if (isSqlMetric(metric)) return sumLike(metric.sql);
  return metric.aggregate === "SUM" || metric.aggregate === "COUNT";
}

/**
 * Ignara's chart header figures (its "Takings against target"): the headline (the total, or
 * the average for non-additive metrics), the target figures when a lollipop has one, the best
 * period, and the range switch. One metric over time only.
 */
function TileFigures({
  state,
  result,
  dataset,
  range,
  onRange,
}: {
  state: ChartState;
  result: ChartDataResult;
  dataset: Dataset | null;
  range: RangeKind | null;
  onRange: ((r: RangeKind) => void) | null;
}) {
  const { query, display, vizType } = state;
  const metric = query.metrics[0];
  const grain = query.time?.grain ?? null;
  if (!metric || query.metrics.length !== 1 || query.series || !query.time?.column || !grain || !["bar", "line", "area"].includes(vizType) || result.rows.length < 2)
    return null;
  const at = Math.max(1, result.columns.findIndex((c) => c.name === metricName(metric)));
  const points = result.rows
    .map((r) => ({ label: r[0], value: toNumber(r[at]) }))
    .filter((p): p is { label: unknown; value: number } => p.value !== null);
  if (!points.length) return null;
  const format = metricFormatter(display, metric, dataset);
  const sum = points.reduce((a, p) => a + p.value, 0);
  const isSum = additive(metric, dataset);
  const headline = isSum ? sum : sum / points.length;
  const best = points.reduce((a, p) => (p.value > a.value ? p : a));
  const word = GRAIN_WORD[grain] ?? "period";
  const target = vizType === "bar" ? (display.bar_target ?? null) : null;
  const beat = target === null ? 0 : points.filter((p) => p.value >= target).length;
  return (
    <div className="tile-figures">
      <span className="tile-fig">
        <small>{isSum ? "Total" : `Average a ${word}`}</small>
        <b className="big">
          <CountUp value={headline} format={(v) => format(v)} />
        </b>
      </span>
      {target !== null && (
        <>
          <span className="tile-fig">
            <small>Beat target</small>
            <b>
              {beat}
              <em>
                {" "}
                of {points.length} {word}s
              </em>
            </b>
          </span>
          <span className="tile-fig">
            <small>
              <i className="tile-fig-dash" aria-hidden />
              Target
            </small>
            <b>
              {format(target)}
              <em> a {word}</em>
            </b>
          </span>
        </>
      )}
      <span className="tile-fig">
        <small>Best {word}</small>
        <b>
          {format(best.value)}
          <em> · {categoryLabel(best.label, grain)}</em>
        </b>
      </span>
      {onRange && (
        <div className="seg tile-range" role="radiogroup" aria-label="Range">
          {RANGES.map(([kind, label]) => (
            <button key={kind} type="button" role="radio" aria-checked={range === kind} className={range === kind ? "active" : ""} onClick={() => onRange(kind)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shimmering placeholder shaped like the chart that is loading (no spinner, no layout jump). */
function TileSkeleton({ viz }: { viz: string | undefined }) {
  return (
    <div className={`tile-skeleton tile-skeleton-${viz ?? "chart"}`} role="status" aria-label="Loading chart">
      {viz === "big_number" ? (
        <>
          <span className="skeleton tile-skeleton-value" />
          <span className="skeleton tile-skeleton-line" />
        </>
      ) : viz === "table" ? (
        Array.from({ length: 5 }, (_, i) => <span key={i} className="skeleton tile-skeleton-line" />)
      ) : (
        <span className="skeleton tile-skeleton-plot" />
      )}
    </div>
  );
}

/** A chart that throws while drawing breaks only its own tile. */
class TileErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: errorText(error) };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="dash-tile-error" role="alert">
          <p>This chart couldn't be drawn: {this.state.error}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

