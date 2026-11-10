import { useEffect, useState } from "react";
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

  const connection = useLoad<Connection>(() => getConnection(id), [id]);
  const schemas = useLoad<string[]>(() => listSchemas(id), [id]);
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

      <div className="browser">
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
