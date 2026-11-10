import { Component, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChartTileSpec, DashboardChartInfo } from "../api.ts";
import ChartView from "../charts/ChartView.tsx";
import { errorText, relativeTime } from "../datasets/format.ts";
import { csvFilename, downloadCsv, toCsv } from "../sqllab/results.ts";
import { useInView } from "./hooks.ts";
import { CancelledError, type QueuedTask } from "./queue.ts";
import { DashboardContext, loadTileData, type TileData } from "./tileData.ts";
import TileMenu from "./TileMenu.tsx";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";

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
  const { queue, datasets, refreshKey, dashboardId, cacheTtl } = ctx;
  // The first load may use the chart-data cache; every reload after it (Refresh, Refresh all,
  // auto-refresh) asks for fresh data.
  const loadedOnce = useRef(false);
  const cacheTtlRef = useRef(cacheTtl);
  cacheTtlRef.current = cacheTtl;

  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const inViewRef = useRef(inView);
  inViewRef.current = inView;
  const task = useRef<QueuedTask<TileData> | null>(null);

  const [data, setData] = useState<TileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ownRefresh, setOwnRefresh] = useState(0);
  const [showSql, setShowSql] = useState(false);

  const measured = inView !== null;
  useEffect(() => {
    if (!measured) return; // wait until we know whether the tile is on screen
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    const refresh = loadedOnce.current;
    const queued = queue.schedule(
      () => loadTileData(tile.chart_id, datasets, controller.signal, { cacheTtl: cacheTtlRef.current, refresh }),
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
        setError(errorText(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      queued.cancel();
      controller.abort();
    };
  }, [measured, queue, datasets, tile.chart_id, refreshKey, ownRefresh]);

  useEffect(() => {
    if (inView) task.current?.setVisible(true);
  }, [inView]);

  // The chart's own title (Customize) wins over its name.
  const name = data?.state.display.title?.trim() || data?.chart.name || info?.name || "Chart";
  const sqls = data ? [data.main.sql, ...(data.trend ? [data.trend.sql] : [])] : [];

  return (
    <div className="dash-tile-inner" ref={ref} data-testid={`tile-${tile.id}`}>
      <div className={`dash-tile-header${editing ? " dash-drag-handle" : ""}`}>
        <span className="dash-tile-title" title={name}>
          {name}
        </span>
        {loading && data && <span className="live-dot" role="status" aria-label="Refreshing" />}
        <span className="spacer" />
        {!loading && data?.main.cached_at && data.state.vizType !== "big_number" && (
          <span className="tile-cached mono" title="From the chart-data cache; Refresh queries again" data-testid="tile-cached">
            cached {relativeTime(data.main.cached_at)}
          </span>
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
              { label: "Edit chart", to: `/charts/${tile.chart_id}?dashboard=${dashboardId}` },
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
            <p>{error}</p>
            <button className="small" onClick={() => setOwnRefresh((k) => k + 1)}>
              Retry
            </button>
          </div>
        ) : data ? (
          <TileErrorBoundary key={data.loadedAt}>
            <ChartView state={data.state} result={data.main} trend={data.trend} previous={data.previous} total={data.total} dataset={data.dataset} />
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
                <span className="mono">
                  {data.main.cached_at
                    ? `cached ${relativeTime(data.main.cached_at)}`
                    : `query ${data.main.duration_ms} ms · refreshed ${relativeTime(new Date(data.loadedAt).toISOString())}`}
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

