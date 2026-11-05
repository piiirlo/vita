// TEMPORARY: bare query playground for Part 3. Replaced by the SQL editor in Part 4.
import { useEffect, useState } from "react";
import { listConnections, runQuery, type Connection, type QueryResult } from "../api.ts";

function formatCell(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function PlaygroundPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [sql, setSql] = useState("SELECT * FROM sales.orders");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listConnections()
      .then((list) => {
        setConnections(list);
        if (list[0]) setConnectionId(list[0].id);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function run() {
    if (connectionId === null) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await runQuery(connectionId, sql));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <h1>Query playground</h1>
      <p className="muted small">Temporary page. The real SQL editor comes in Part 4.</p>

      <p>
        <select
          value={connectionId ?? ""}
          onChange={(e) => setConnectionId(Number(e.target.value))}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>{" "}
        <button className="primary" onClick={() => void run()} disabled={running || connectionId === null}>
          {running ? "Running…" : "Run"}
        </button>
      </p>

      <textarea
        className="mono"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        rows={8}
        style={{ width: "100%" }}
      />

      {error && <p className="alert alert-error">{error}</p>}

      {result && (
        <>
          <p>
            {result.row_count} rows in {result.duration_ms} ms
            {result.truncated && (
              <strong> — truncated: only the first {result.row_count} rows are shown.</strong>
            )}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table compact">
              <thead>
                <tr>
                  {result.columns.map((c, i) => (
                    <th key={i} title={c.db_type}>
                      {c.name} <span className="muted">({c.type})</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((v, c) => (
                      <td key={c} className="mono">
                        {formatCell(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
