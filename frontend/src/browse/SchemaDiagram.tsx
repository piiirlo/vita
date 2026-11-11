import { ChevronDown, ChevronRight, KeyRound, Link2, Maximize, Minus, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router";
import { getSchemaDiagram, runQuery, type DbType, type QueryResult, type SchemaDiagram as Diagram } from "../api.ts";
import { ErrorAlert } from "../components/ui/alert.tsx";
import type { SqlLabLocationState } from "../datasets/sqlLabLink.ts";
import {
  MAX_SHOWN_COLUMNS,
  centerOn,
  fitAll,
  layoutDiagram,
  neighbors,
  searchTables,
  selectAllSql,
  type EdgeLine,
} from "./diagramLayout.ts";

type Props = { connectionId: number; dbType: DbType; schema: string };
type View = { x: number; y: number; scale: number };

const MIN_SCALE = 0.15;
const MAX_SCALE = 2;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** The schema as a diagram: tables as cards (collapsed by default), lines for foreign keys,
 * auto-laid out; pan by dragging, zoom with the wheel or the buttons; search highlights a
 * table and its neighbors and glides to it; click a table for its columns, Preview and
 * "Open in SQL Lab". Movement is CSS transitions, so reduced motion turns it off. */
export default function SchemaDiagram({ connectionId, dbType, schema }: Props) {
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [gliding, setGliding] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDiagram(null);
    setError(null);
    setSelected(null);
    setExpanded(new Set());
    getSchemaDiagram(connectionId, schema, controller.signal)
      .then(setDiagram)
      .catch((err: unknown) => !controller.signal.aborted && setError(err instanceof Error ? err.message : String(err)));
    return () => controller.abort();
  }, [connectionId, schema]);

  const layout = useMemo(() => (diagram ? layoutDiagram(diagram, expanded) : null), [diagram, expanded]);

  const viewportSize = () => ({ width: viewport.current?.clientWidth || 800, height: viewport.current?.clientHeight || 600 });
  const glide = useCallback((next: View) => {
    setGliding(true);
    setView(next);
  }, []);

  // Fit the whole schema when it first arrives (before it is painted: no jump).
  const fitted = useRef<Diagram | null>(null);
  useLayoutEffect(() => {
    if (!layout || !diagram || fitted.current === diagram) return;
    fitted.current = diagram;
    setView(fitAll(layout, viewportSize()));
  }, [layout, diagram]);

  const matches = useMemo(() => (diagram ? searchTables(diagram, query) : []), [diagram, query]);
  const active = selected ?? matches[0] ?? null;
  const focus = useMemo(() => {
    if (!diagram || !active) return null;
    return new Set([active, ...neighbors(diagram, active)]);
  }, [diagram, active]);

  function focusTable(name: string) {
    const box = layout?.nodes.get(name);
    if (box) glide(centerOn(box, viewportSize(), Math.max(view.scale, 0.85)));
  }

  function zoomBy(factor: number, at?: { x: number; y: number }) {
    const size = viewportSize();
    const point = at ?? { x: size.width / 2, y: size.height / 2 };
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      return { scale, x: point.x - ((point.x - v.x) * scale) / v.scale, y: point.y - ((point.y - v.y) * scale) / v.scale };
    });
  }

  // Wheel zoom around the pointer (a native listener: React's is passive).
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setGliding(false);
      const rect = el.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest(".diagram-card, .diagram-toolbar")) return;
    setGliding(false);
    drag.current = { x: e.clientX, y: e.clientY, view };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    setView({ ...d.view, x: d.view.x + e.clientX - d.x, y: d.view.y + e.clientY - d.y });
  }
  function onPointerUp() {
    drag.current = null;
  }

  function toggle(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  if (error) return <ErrorAlert>{error}</ErrorAlert>;
  if (!diagram || !layout) {
    return (
      <div className="diagram diagram-loading" role="status" aria-label="Loading diagram">
        <span className="skeleton" />
        <span className="skeleton" />
        <span className="skeleton" />
      </div>
    );
  }
  if (diagram.tables.length === 0) return <p className="muted pad">No tables in {schema}.</p>;

  const selectedTable = selected ? diagram.tables.find((t) => t.name === selected) : undefined;

  return (
    <div className="diagram-wrap">
      <div className="diagram-toolbar">
        <label className="diagram-search">
          <Search size={15} aria-hidden />
          <input
            aria-label="Find a table"
            placeholder={`Find a table (${diagram.tables.length})`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) focusTable(matches[0]);
              if (e.key === "Escape") setQuery("");
            }}
          />
          {query && (
            <span className="diagram-search-count mono" aria-live="polite">
              {matches.length} found
            </span>
          )}
        </label>
        <span className="spacer" />
        <button type="button" className="small" onClick={() => setExpanded(new Set(diagram.tables.map((t) => t.name)))}>
          Expand all
        </button>
        <button type="button" className="small" onClick={() => setExpanded(new Set())}>
          Collapse all
        </button>
        <button type="button" className="icon small" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          <Minus size={15} aria-hidden />
        </button>
        <span className="mono small diagram-zoom" aria-label="Zoom level">
          {Math.round(view.scale * 100)}%
        </span>
        <button type="button" className="icon small" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
          <Plus size={15} aria-hidden />
        </button>
        <button type="button" className="icon small" aria-label="Fit to screen" onClick={() => glide(fitAll(layout, viewportSize()))}>
          <Maximize size={15} aria-hidden />
        </button>
      </div>
      {diagram.truncated && (
        <p className="alert alert-warning compact">Only the first {diagram.tables.length} tables (by name) are shown.</p>
      )}

      <div className="diagram-body">
        <div
          ref={viewport}
          className="diagram"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={(e) => e.key === "Escape" && setSelected(null)}
          data-testid="diagram"
        >
          <div
            className={`diagram-canvas${gliding ? " gliding" : ""}`}
            style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            onTransitionEnd={() => setGliding(false)}
          >
            <svg className="diagram-edges" width={layout.width} height={layout.height} aria-hidden>
              {layout.edges.map((e) => (
                <EdgePath key={e.id} edge={e} lit={Boolean(active && (e.from === active || e.to === active))} dim={Boolean(focus && !(focus.has(e.from) && focus.has(e.to)))} />
              ))}
            </svg>
            {diagram.tables.map((t) => {
              const box = layout.nodes.get(t.name);
              if (!box) return null;
              const isOpen = expanded.has(t.name);
              const pk = t.columns.filter((c) => c.primary_key).map((c) => c.name);
              const fkCount = t.columns.filter((c) => c.foreign_key).length;
              const state = active === t.name ? " is-active" : focus?.has(t.name) ? " is-near" : focus ? " is-dim" : "";
              return (
                <div
                  key={t.name}
                  className={`diagram-card${state}`}
                  style={{ width: box.width, height: box.height, transform: `translate(${box.x}px, ${box.y}px)` }}
                  data-testid={`table-${t.name}`}
                >
                  <div className="diagram-card-head">
                    <button
                      type="button"
                      className="diagram-card-name mono"
                      onClick={() => setSelected(t.name === selected ? null : t.name)}
                      aria-pressed={t.name === selected}
                      title={t.name}
                    >
                      {t.name}
                    </button>
                    {t.type === "view" && <span className="tag">view</span>}
                    <button
                      type="button"
                      className="icon small diagram-card-toggle"
                      aria-label={`${isOpen ? "Collapse" : "Expand"} ${t.name}`}
                      aria-expanded={isOpen}
                      onClick={() => toggle(t.name)}
                    >
                      {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                    </button>
                  </div>
                  {isOpen ? (
                    <ul className="diagram-columns">
                      {t.columns.slice(0, MAX_SHOWN_COLUMNS).map((c) => (
                        <li key={c.name}>
                          <span className="diagram-col-name mono">
                            {c.primary_key && <KeyRound size={11} aria-label="Primary key" className="pk-icon" />}
                            {c.foreign_key && <Link2 size={11} aria-label="Foreign key" className="fk-icon" />}
                            {c.name}
                          </span>
                          <span className="diagram-col-type mono">{c.type}</span>
                        </li>
                      ))}
                      {t.columns.length > MAX_SHOWN_COLUMNS && (
                        <li className="muted">+ {t.columns.length - MAX_SHOWN_COLUMNS} more (click the name)</li>
                      )}
                    </ul>
                  ) : (
                    <p className="diagram-summary mono">
                      {t.columns.length} col{t.columns.length === 1 ? "" : "s"}
                      {pk.length > 0 && ` · PK ${pk.join(", ")}`}
                      {fkCount > 0 && ` · ${fkCount} FK`}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {selectedTable && (
          <TablePanel
            key={selectedTable.name}
            diagram={diagram}
            table={selectedTable.name}
            connectionId={connectionId}
            dbType={dbType}
            onPick={(name) => {
              setSelected(name);
              focusTable(name);
            }}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

function EdgePath({ edge, lit, dim }: { edge: EdgeLine; lit: boolean; dim: boolean }) {
  const pts = edge.points;
  if (pts.length < 2) return null;
  // A smooth curve through dagre's points.
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mid = { x: (pts[i]!.x + pts[i + 1]!.x) / 2, y: (pts[i]!.y + pts[i + 1]!.y) / 2 };
    d += ` Q ${pts[i]!.x} ${pts[i]!.y} ${mid.x} ${mid.y}`;
  }
  const last = pts.at(-1)!;
  d += ` L ${last.x} ${last.y}`;
  return (
    <g className={`diagram-edge${lit ? " is-lit" : ""}${dim ? " is-dim" : ""}`}>
      <title>{edge.label}</title>
      <path d={d} />
      <circle cx={pts[0]!.x} cy={pts[0]!.y} r={3.5} />
    </g>
  );
}

function TablePanel({
  diagram,
  table,
  connectionId,
  dbType,
  onPick,
  onClose,
}: {
  diagram: Diagram;
  table: string;
  connectionId: number;
  dbType: DbType;
  onPick(name: string): void;
  onClose(): void;
}) {
  const navigate = useNavigate();
  const info = diagram.tables.find((t) => t.name === table)!;
  const outgoing = diagram.foreign_keys.filter((fk) => fk.table === table);
  const incoming = diagram.foreign_keys.filter((fk) => fk.referred_table === table && fk.referred_schema === diagram.schema_name);
  const [preview, setPreview] = useState<{ status: "loading" } | { status: "done"; result: QueryResult } | { status: "error"; message: string } | null>(null);

  async function runPreview() {
    setPreview({ status: "loading" });
    try {
      const result = await runQuery(connectionId, selectAllSql(diagram.schema_name, table, dbType, 20), 20);
      setPreview({ status: "done", result });
    } catch (err) {
      setPreview({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function openInSqlLab() {
    const state: SqlLabLocationState = {
      openTab: { title: table, sql: selectAllSql(diagram.schema_name, table, dbType), connectionId, schema: diagram.schema_name },
    };
    void navigate("/sql-lab", { state });
  }

  return (
    <aside className="diagram-panel" aria-label={`Table ${table}`}>
      <div className="diagram-panel-head">
        <h3 className="mono">{table}</h3>
        {info.type === "view" && <span className="tag">view</span>}
        <span className="spacer" />
        <button type="button" className="icon small" aria-label="Close" onClick={onClose}>
          <X size={15} aria-hidden />
        </button>
      </div>
      <div className="diagram-panel-actions">
        <button type="button" className="small" onClick={() => void runPreview()} disabled={preview?.status === "loading"}>
          Preview
        </button>
        <button type="button" className="small primary" onClick={openInSqlLab}>
          Open in SQL Lab
        </button>
      </div>
      <table className="data-table compact">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>
              <span className="sr-only">Keys</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {info.columns.map((c) => (
            <tr key={c.name}>
              <td className="mono">{c.name}</td>
              <td className="mono muted">{c.type}</td>
              <td>
                {c.primary_key && <span className="tag tag-pk">PK</span>}
                {c.foreign_key && <span className="tag">FK</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(outgoing.length > 0 || incoming.length > 0) && (
        <div className="diagram-links">
          <h4 className="eyebrow">Foreign keys</h4>
          <ul>
            {outgoing.map((fk, i) => (
              <li key={`o${i}`}>
                <span className="mono">{fk.columns.join(", ")}</span> →{" "}
                <button type="button" className="link-button mono" onClick={() => onPick(fk.referred_table)}>
                  {fk.referred_table}
                </button>
                <span className="mono muted">.{fk.referred_columns.join(", ")}</span>
              </li>
            ))}
            {incoming.map((fk, i) => (
              <li key={`i${i}`}>
                <button type="button" className="link-button mono" onClick={() => onPick(fk.table)}>
                  {fk.table}
                </button>
                <span className="mono muted">.{fk.columns.join(", ")}</span> → <span className="mono">{fk.referred_columns.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview?.status === "loading" && <span className="skeleton diagram-preview-skeleton" role="status" aria-label="Loading preview" />}
      {preview?.status === "error" && <ErrorAlert>{preview.message}</ErrorAlert>}
      {preview?.status === "done" && (
        <div className="diagram-preview table-scroll">
          <table className="data-table compact">
            <thead>
              <tr>
                {preview.result.columns.map((c) => (
                  <th key={c.name}>{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.result.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((v, j) => (
                    <td key={j} className="mono">
                      {v === null ? <span className="muted">NULL</span> : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">First {preview.result.rows.length} rows.</p>
        </div>
      )}
    </aside>
  );
}
