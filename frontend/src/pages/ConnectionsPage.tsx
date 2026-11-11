import { useCallback, useEffect, useState } from "react";
import { Network } from "lucide-react";
import { Link } from "react-router";
import {
  ApiError,
  deleteConnection,
  listConnections,
  testSavedConnection,
  type Connection,
  type TestResult,
} from "../api.ts";
import TestResultMessage from "../components/TestResultMessage.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";
import EmptyState from "../components/EmptyState.tsx";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { toast } from "../components/toast.ts";
import { Button } from "../components/ui/button.tsx";
import PageHeader from "../shell/PageHeader.tsx";

export default function ConnectionsPage() {
  usePageTitle("Connections");
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when a delete was refused because datasets still use the connection.
  const [inUse, setInUse] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, TestResult>>({});
  const [toDelete, setToDelete] = useState<Connection | null>(null);

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
    try {
      await deleteConnection(conn.id);
      setInUse(false);
      setToDelete(null);
      toast.success(`Deleted "${conn.name}".`);
      await load();
    } catch (err) {
      // 409: "This connection is used by 2 datasets: X, Y. Delete those first."
      setInUse(err instanceof ApiError && err.status === 409);
      setToDelete(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Data sources"
        title="Connections"
        actions={
          <Button asChild variant="primary">
            <Link to="/connections/new">Add connection</Link>
          </Button>
        }
      />

      {error && (
        <p className="alert alert-error">
          {error}
          {inUse && (
            <>
              {" "}
              <Link to="/datasets">Go to datasets</Link>
            </>
          )}
        </p>
      )}
      {connections === null && !error && <p className="muted">Loading…</p>}

      {connections?.length === 0 && (
        <EmptyState
          icon={Network}
          title="No connections yet"
          action={
            <Link to="/connections/new" className="button primary">
              Add connection
            </Link>
          }
        >
          Try the demo database: host <code>sampledb</code>, port <code>5432</code>, database <code>sampledb</code>.
        </EmptyState>
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
            {connections.map((conn, index) => {
              const result = testResults[conn.id];
              return (
                <tr key={conn.id} className="stagger-item" data-enter={Math.min(index, 12)}>
                  <td>
                    <Link to={`/connections/${conn.id}/browse`} className="row-title">{conn.name}</Link>
                    {conn.builtin === "uploads" && (
                      <span className="tag tag-builtin" title="Managed by Vita: the tables of your uploaded files (read-only)">
                        Uploads
                      </span>
                    )}
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
                    {!conn.builtin && (
                      <>
                        <Link to={`/connections/${conn.id}/edit`} className="button">
                          Edit
                        </Link>
                        <button className="danger" onClick={() => setToDelete(conn)}>
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {toDelete && (
        <ConfirmDialog
          title="Delete connection"
          confirmLabel="Delete"
          onConfirm={() => handleDelete(toDelete)}
          onCancel={() => setToDelete(null)}
        >
          <p>
            Delete the connection <strong>{toDelete.name}</strong>? This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
