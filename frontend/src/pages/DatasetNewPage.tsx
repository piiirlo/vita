import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  createDataset,
  listConnections,
  listSchemas,
  listTables,
  type Connection,
  type TableInfo,
} from "../api.ts";
import { errorText } from "../datasets/format.ts";

/** Create a dataset from a table: pick connection, schema, table. */
export default function DatasetNewPage() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [table, setTable] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listConnections()
      .then((list) => {
        setConnections(list);
        if (list.length > 0) setConnectionId(list[0]!.id);
      })
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  useEffect(() => {
    if (connectionId === null) return;
    let cancelled = false;
    setSchemas(null);
    setSchema("");
    setLoadError(null);
    listSchemas(connectionId)
      .then((list) => {
        if (cancelled) return;
        setSchemas(list);
        const conn = connections?.find((c) => c.id === connectionId);
        const preferred = conn?.db_type === "mysql" ? conn.database : "public";
        setSchema(list.includes(preferred) ? preferred : (list[0] ?? ""));
      })
      .catch((err: unknown) => !cancelled && setLoadError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [connectionId, connections]);

  useEffect(() => {
    if (connectionId === null || !schema) {
      setTables(null);
      return;
    }
    let cancelled = false;
    setTables(null);
    setTable("");
    listTables(connectionId, schema)
      .then((list) => !cancelled && setTables(list))
      .catch((err: unknown) => !cancelled && setLoadError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema]);

  function pickTable(value: string) {
    setTable(value);
    if (!nameTouched) setName(value);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (connectionId === null || !schema || !table) {
      setError("Pick a connection, schema and table.");
      return;
    }
    if (!name.trim()) {
      setError("Please enter a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const dataset = await createDataset({
        name: name.trim(),
        description: description.trim() || null,
        connection_id: connectionId,
        kind: "table",
        schema,
        table_name: table,
      });
      navigate(`/datasets/${dataset.id}`);
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  }

  if (connections?.length === 0) {
    return (
      <div className="card empty">
        <p>A dataset needs a database connection first.</p>
        <Link to="/connections/new" className="button primary">
          Add a connection
        </Link>
      </div>
    );
  }

  return (
    <div className="narrow">
      <div className="page-header">
        <h1>
          <Link to="/datasets" className="crumb">
            Datasets
          </Link>{" "}
          / New
        </h1>
      </div>
      <p className="muted">
        Create a dataset from a table or view. To use a SQL query instead, write it in{" "}
        <Link to="/sql-lab">SQL Lab</Link> and click “Save as dataset”.
      </p>

      <form className="card form" onSubmit={(e) => void submit(e)}>
        <label>
          Connection
          <select
            value={connectionId ?? ""}
            onChange={(e) => setConnectionId(Number(e.target.value))}
            disabled={connections === null}
          >
            {connections?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Schema
          <select value={schema} onChange={(e) => setSchema(e.target.value)} disabled={schemas === null}>
            {schemas === null && <option value="">Loading…</option>}
            {schemas?.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Table
          <select value={table} onChange={(e) => pickTable(e.target.value)} disabled={tables === null}>
            <option value="">{tables === null ? "Loading…" : tables.length ? "Pick a table…" : "No tables"}</option>
            {tables?.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.type === "view" ? " (view)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
          />
        </label>
        <label>
          Description <span className="muted">(optional)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </label>

        {loadError && <p className="alert alert-error">{loadError}</p>}
        {error && <p className="alert alert-error">{error}</p>}
        <div className="form-actions">
          <span className="spacer" />
          <Link to="/datasets" className="button">
            Cancel
          </Link>
          <button type="submit" className="primary" disabled={saving || !table}>
            {saving ? "Reading columns…" : "Create dataset"}
          </button>
        </div>
      </form>
    </div>
  );
}
