import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  deleteConnection,
  listConnections,
  testSavedConnection,
  type Connection,
  type TestResult,
} from "../api.ts";
import TestResultMessage from "../components/TestResultMessage.tsx";

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, TestResult>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setConnections(await listConnections());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleTest(conn: Connection) {
    setTesting(conn.id);
    try {
      const result = await testSavedConnection(conn.id);
      setTestResults((prev) => ({ ...prev, [conn.id]: result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestResults((prev) => ({ ...prev, [conn.id]: { ok: false, error: message } }));
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(conn: Connection) {
    if (!window.confirm(`Delete connection "${conn.name}"? This cannot be undone.`)) return;
    try {
      await deleteConnection(conn.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Connections</h1>
        <Link to="/connections/new" className="button primary">
          Add connection
        </Link>
      </div>

      {error && <p className="alert alert-error">{error}</p>}
      {connections === null && !error && <p className="muted">Loading…</p>}

      {connections?.length === 0 && (
        <div className="card empty">
          <p>No connections yet.</p>
          <p className="muted small">
            Try the demo database: host <code>sampledb</code>, port <code>5432</code>, database{" "}
            <code>sampledb</code>.
          </p>
        </div>
      )}

      {connections && connections.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Location</th>
              <th>User</th>
              <th>Password</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {connections.map((conn) => {
              const result = testResults[conn.id];
              return (
                <tr key={conn.id}>
                  <td>
                    <Link to={`/connections/${conn.id}/browse`}>{conn.name}</Link>
                    {result && <TestResultMessage result={result} compact />}
                  </td>
                  <td>{conn.db_type === "postgresql" ? "PostgreSQL" : "MySQL"}</td>
                  <td className="mono">
                    {conn.host}:{conn.port}/{conn.database}
                  </td>
                  <td>{conn.username}</td>
                  <td className={conn.has_password ? "" : "muted"}>
                    {conn.has_password ? "set" : "none"}
                  </td>
                  <td className="actions">
                    <button onClick={() => void handleTest(conn)} disabled={testing === conn.id}>
                      {testing === conn.id ? "Testing…" : "Test"}
                    </button>
                    <Link to={`/connections/${conn.id}/browse`} className="button">
                      Browse
                    </Link>
                    <Link to={`/connections/${conn.id}/edit`} className="button">
                      Edit
                    </Link>
                    <button className="danger" onClick={() => void handleDelete(conn)}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
