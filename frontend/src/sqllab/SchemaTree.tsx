import { useEffect, useState } from "react";
import type { ColumnInfo, DbType, TableInfo } from "../api.ts";
import { qualifiedName, quoteIdent } from "./completion.ts";
import { clearConnectionCache, getColumns, getSchemas, getTables } from "./schemaCache.ts";

type Props = {
  connectionId: number;
  dbType: DbType;
  /** The schema picked in the toolbar: expanded by default. */
  schema: string | null;
  onInsert(text: string): void;
  onPreview(schema: string, table: string): void;
};

type Loadable<T> = { data: T } | { error: string } | undefined;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function SchemaTree({ connectionId, dbType, schema, onInsert, onPreview }: Props) {
  const [version, setVersion] = useState(0); // bumped by "Refresh"
  const [search, setSearch] = useState("");
  const [schemas, setSchemas] = useState<Loadable<string[]>>();
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  const [tables, setTables] = useState<Record<string, Loadable<TableInfo[]>>>({});
  const [openTables, setOpenTables] = useState<Set<string>>(new Set());
  const [columns, setColumns] = useState<Record<string, Loadable<ColumnInfo[]>>>({});

  useEffect(() => {
    let cancelled = false;
    setSchemas(undefined);
    setTables({});
    setColumns({});
    setOpenTables(new Set());
    setOpenSchemas(new Set(schema ? [schema] : []));
    getSchemas(connectionId)
      .then((data) => !cancelled && setSchemas({ data }))
      .catch((err: unknown) => !cancelled && setSchemas({ error: message(err) }));
    return () => {
      cancelled = true;
    };
    // Not `schema`: picking a schema must not reset the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, version]);

  // The toolbar's schema is open by default.
  useEffect(() => {
    if (schema) setOpenSchemas((prev) => new Set(prev).add(schema));
  }, [schema, connectionId]);

  // Load tables of every open schema.
  useEffect(() => {
    for (const s of openSchemas) {
      if (tables[s]) continue;
      getTables(connectionId, s)
        .then((data) => setTables((prev) => ({ ...prev, [s]: { data } })))
        .catch((err: unknown) => setTables((prev) => ({ ...prev, [s]: { error: message(err) } })));
    }
  }, [openSchemas, tables, connectionId]);

  function toggleSchema(name: string) {
    setOpenSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleTable(s: string, t: string) {
    const key = `${s}.${t}`;
    setOpenTables((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!columns[key]) {
      getColumns(connectionId, s, t)
        .then((data) => setColumns((prev) => ({ ...prev, [key]: { data } })))
        .catch((err: unknown) => setColumns((prev) => ({ ...prev, [key]: { error: message(err) } })));
    }
  }

  function refresh() {
    clearConnectionCache(connectionId);
    setVersion((v) => v + 1);
  }

  const needle = search.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);

  return (
    <div className="schema-tree">
      <div className="panel-search">
        <input
          type="search"
          placeholder="Search tables and columns"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search tables and columns"
        />
        <button className="small icon" title="Reload schema metadata" onClick={refresh}>
          ⟳
        </button>
      </div>

      {schemas === undefined && <p className="muted small pad">Loading schemas…</p>}
      {schemas && "error" in schemas && <p className="alert alert-error compact">{schemas.error}</p>}

      <ul className="tree">
        {schemas &&
          "data" in schemas &&
          schemas.data.map((s) => {
            const loaded = tables[s];
            const tableList = loaded && "data" in loaded ? loaded.data : [];
            const visibleTables = tableList.filter((t) => {
              if (matches(t.name)) return true;
              const cols = columns[`${s}.${t.name}`];
              return cols && "data" in cols && cols.data.some((c) => matches(c.name));
            });
            // While searching, hide schemas without any match among loaded tables.
            if (needle && !matches(s) && visibleTables.length === 0) return null;
            const open = openSchemas.has(s);
            return (
              <li key={s}>
                <div className="tree-row">
                  <button className="tree-toggle" onClick={() => toggleSchema(s)} aria-label={`Toggle ${s}`}>
                    {open ? "▾" : "▸"}
                  </button>
                  <span className="tree-icon schema" aria-hidden />
                  <button className="tree-name" title="Insert schema name" onClick={() => onInsert(quoteIdent(s, dbType))}>
                    {s}
                  </button>
                </div>
                {open && (
                  <ul>
                    {loaded === undefined && <li className="muted small pad">Loading…</li>}
                    {loaded && "error" in loaded && <li className="alert alert-error compact">{loaded.error}</li>}
                    {loaded && "data" in loaded && tableList.length === 0 && <li className="muted small pad">No tables</li>}
                    {visibleTables.map((t) => {
                      const key = `${s}.${t.name}`;
                      const tableOpen = openTables.has(key) || (needle !== "" && !matches(t.name));
                      const cols = columns[key];
                      return (
                        <li key={t.name}>
                          <div className="tree-row">
                            <button className="tree-toggle" onClick={() => toggleTable(s, t.name)} aria-label={`Toggle ${t.name}`}>
                              {tableOpen ? "▾" : "▸"}
                            </button>
                            <span className={`tree-icon ${t.type}`} aria-hidden />
                            <button
                              className="tree-name"
                              title={`Insert ${s}.${t.name}`}
                              onClick={() => onInsert(qualifiedName(s, t.name, dbType))}
                            >
                              {t.name}
                            </button>
                            {t.type === "view" && <span className="tag">view</span>}
                            <button className="tree-action" title="SELECT * … LIMIT 100" onClick={() => onPreview(s, t.name)}>
                              Preview
                            </button>
                          </div>
                          {tableOpen && (
                            <ul>
                              {cols === undefined && <li className="muted small pad">Loading…</li>}
                              {cols && "error" in cols && <li className="alert alert-error compact">{cols.error}</li>}
                              {cols &&
                                "data" in cols &&
                                cols.data
                                  .filter((c) => matches(c.name) || matches(t.name))
                                  .map((c) => (
                                    <li key={c.name} className="tree-row tree-column">
                                      <button
                                        className="tree-name"
                                        title={`Insert ${c.name}`}
                                        onClick={() => onInsert(quoteIdent(c.name, dbType))}
                                      >
                                        {c.name}
                                      </button>
                                      {c.primary_key && <span className="tag tag-pk">PK</span>}
                                      <span className="tree-type">{c.type.toLowerCase()}</span>
                                    </li>
                                  ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
      </ul>
    </div>
  );
}
