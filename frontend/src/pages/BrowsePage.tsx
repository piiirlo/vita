import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  getConnection,
  listColumns,
  listSchemas,
  listTables,
  type ColumnInfo,
  type Connection,
  type TableInfo,
} from "../api.ts";
import { usePageTitle } from "../components/usePageTitle.ts";
import PageHeader from "../shell/PageHeader.tsx";
import { Button } from "../components/ui/button.tsx";

// The diagram (and dagre) load only when someone opens it.
const SchemaDiagram = lazy(() => import("../browse/SchemaDiagram.tsx"));

type BrowseView = "list" | "diagram";
const VIEW_KEY = "vita.browse.view";
function savedView(): BrowseView {
  try {
    return localStorage.getItem(VIEW_KEY) === "diagram" ? "diagram" : "list";
  } catch {
    return "list";
  }
}

/** Result of an async load: null while loading, or data, or an error message. */
type Loaded<T> = { data: T; error: null } | { data: null; error: string } | null;

function useLoad<T>(load: (() => Promise<T>) | null, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>(null);
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    setState(null);
    load()
      .then((data) => !cancelled && setState({ data, error: null }))
      .catch((err: unknown) => {
        if (!cancelled) setState({ data: null, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // `load` is a new function every render; `deps` says when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

function Status({ state }: { state: Loaded<unknown> }) {
  if (state === null) return <p className="muted small pad">Loading…</p>;
  if (state.error !== null) return <p className="alert alert-error compact">{state.error}</p>;
  return null;
}

export default function BrowsePage() {
  usePageTitle("Browse");
  const id = Number(useParams().id);
  const [schema, setSchema] = useState<string | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [view, setViewState] = useState<BrowseView>(savedView);
  function setView(next: BrowseView) {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // just not remembered
    }
  }

  const connection = useLoad<Connection>(() => getConnection(id), [id]);
  const schemas = useLoad<string[]>(() => listSchemas(id), [id]);
  // The diagram shows one schema: the picked one, else "public", else the first.
  const diagramSchema = schema ?? (schemas?.data?.includes("public") ? "public" : (schemas?.data?.[0] ?? null));
  const tables = useLoad<TableInfo[]>(schema ? () => listTables(id, schema) : null, [id, schema]);
  const columns = useLoad<ColumnInfo[]>(
    schema && table ? () => listColumns(id, schema, table) : null,
    [id, schema, table],
  );

  function selectSchema(name: string) {
    setSchema(name);
    setTable(null);
  }

  return (
    <div>
      <PageHeader
        eyebrow={
          <>
            <Link to="/connections" className="crumb">
              Connections
            </Link>{" "}
            / Browse
          </>
        }
        title={connection?.data?.name ?? "…"}
        actions={
          <Button asChild>
            <Link to={`/connections/${id}/edit`}>Edit connection</Link>
          </Button>
        }
      />
      {connection?.error && <p className="alert alert-error">{connection.error}</p>}

      <div className="browse-view-bar">
        <div className="segmented" role="radiogroup" aria-label="View">
          {(["list", "diagram"] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {v === "list" ? "List" : "Diagram"}
            </button>
          ))}
        </div>
        {view === "diagram" && schemas?.data && schemas.data.length > 0 && (
          <label className="inline-label small">
            Schema
            <select aria-label="Schema" value={diagramSchema ?? ""} onChange={(e) => selectSchema(e.target.value)}>
              {schemas.data.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {view === "diagram" && (
        <>
          <Status state={schemas} />
          {schemas?.data && schemas.data.length === 0 && <p className="muted small pad">No schemas.</p>}
          {diagramSchema && connection?.data && (
            <Suspense
              fallback={
                <div className="diagram diagram-loading" role="status" aria-label="Loading diagram">
                  <span className="skeleton" />
                  <span className="skeleton" />
                  <span className="skeleton" />
                </div>
              }
            >
              <SchemaDiagram connectionId={id} dbType={connection.data.db_type} schema={diagramSchema} />
            </Suspense>
          )}
        </>
      )}

      <div className="browser" hidden={view !== "list"}>
        <section className="panel">
          <h2>Schemas</h2>
          <Status state={schemas} />
          {schemas?.data && schemas.data.length === 0 && <p className="muted small pad">No schemas.</p>}
          <ul className="pick-list">
            {schemas?.data?.map((name) => (
              <li key={name}>
                <button
                  className={name === schema ? "selected" : ""}
                  onClick={() => selectSchema(name)}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>Tables</h2>
          {!schema && <p className="muted small pad">Pick a schema.</p>}
          {schema && <Status state={tables} />}
          {tables?.data && tables.data.length === 0 && <p className="muted small pad">No tables.</p>}
          <ul className="pick-list">
            {schema &&
              tables?.data?.map((t) => (
                <li key={t.name}>
                  <button
                    className={t.name === table ? "selected" : ""}
                    onClick={() => setTable(t.name)}
                  >
                    {t.name}
                    {t.type === "view" && <span className="tag">view</span>}
                  </button>
                </li>
              ))}
          </ul>
        </section>

        <section className="panel panel-wide">
          <h2>{table ? `Columns of ${schema}.${table}` : "Columns"}</h2>
          {!table && <p className="muted small pad">Pick a table.</p>}
          {table && <Status state={columns} />}
          {table && columns?.data && (
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  <th>Primary key</th>
                </tr>
              </thead>
              <tbody>
                {columns.data.map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.name}</td>
                    <td className="mono muted">{c.type}</td>
                    <td>{c.nullable ? "yes" : "no"}</td>
                    <td>{c.primary_key && <span className="tag tag-pk">PK</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
