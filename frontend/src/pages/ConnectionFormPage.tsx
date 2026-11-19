import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {  
  EXTRA_OPTIONS_EXAMPLES,
  createConnection,
  getConnection,
  testConnectionDetails,
  updateConnection,
  type ConnectionFields,
  type DbType,
  type TestResult,
} from "../api.ts";
import TestResultMessage from "../components/TestResultMessage.tsx";
import { usePageTitle } from "../components/usePageTitle.ts";
import { toast } from "../components/toast.ts";
import PageHeader from "../shell/PageHeader.tsx";
import { EMPTY_FORM, looksLikeHostname, portAfterTypeChange, toFields, type FormState } from "../connections/connectionForm.ts";
import { projectPath } from "../projects/paths.ts";
import { useCrumbTitle } from "../projects/projectContext.ts";

export default function ConnectionFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const isEdit = editId !== null;
  const navigate = useNavigate();
  usePageTitle(isEdit ? "Edit connection" : "New connection");
  useCrumbTitle(isEdit ? "Edit connection" : "New connection");

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [savedHasPassword, setSavedHasPassword] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);

  useEffect(() => {
    if (editId === null) return;
    getConnection(editId)
      .then((conn) => {
        setForm({
          name: conn.name,
          db_type: conn.db_type,
          host: conn.host,
          port: String(conn.port),
          database: conn.database,
          username: conn.username,
          password: "",
          noPassword: false,
          extra: conn.extra ? JSON.stringify(conn.extra, null, 2) : "",
        });
        setSavedHasPassword(conn.has_password);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [editId]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestResult(null); // an old test result no longer applies
  }

  function changeDbType(dbType: DbType) {
    setForm((prev) => ({
      ...prev,
      db_type: dbType,
      port: portAfterTypeChange(prev.port, prev.db_type, dbType),
    }));
    setTestResult(null);
  }

  function setNoPassword(checked: boolean) {
    setForm((prev) => ({ ...prev, noPassword: checked, password: checked ? "" : prev.password }));
    setTestResult(null);
  }

  const dbLooksLikeHost = looksLikeHostname(form.database, form.host);

  async function handleTest() {
    setError(null);
    setTestResult(null);
    let fields: ConnectionFields;
    try {
      fields = toFields(form);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setBusy("test");
    try {
      setTestResult(await testConnectionDetails(fields, editId ?? undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError("Please give the connection a name.");
      return;
    }
    let fields: ConnectionFields;
    try {
      fields = toFields(form);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setBusy("save");
    try {
      const input = { ...fields, name: form.name.trim() };
      if (editId !== null) await updateConnection(editId, input);
      else await createConnection(input);
      toast.success(`Saved "${input.name}".`);
      void navigate(projectPath("/connections"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div className="narrow">
      <PageHeader
        eyebrow={
          <Link to={projectPath("/connections")} className="crumb">
            Connections
          </Link>
        }
        title={isEdit ? "Edit connection" : "Add connection"}
        search={false}
      />

      <form className="card form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Sales demo"
            autoFocus
          />
        </label>

        <label>
          Database type
          <select
            value={form.db_type}
            onChange={(e) => changeDbType(e.target.value as DbType)}
          >
            <option value="postgresql">PostgreSQL</option>
            <option value="mysql">MySQL</option>
          </select>
        </label>

        <div className="row">
          <label className="grow">
            Host
            <input
              value={form.host}
              onChange={(e) => update("host", e.target.value)}
              placeholder="e.g. sampledb"
            />
          </label>
          <label className="port">
            Port
            <input
              value={form.port}
              onChange={(e) => update("port", e.target.value)}
              inputMode="numeric"
            />
          </label>
        </div>
        <p className="hint">
          The Vita backend runs inside Docker, so <code>localhost</code> means the container
          itself. For a database on your Windows machine use <code>host.docker.internal</code>.
          For the demo database use <code>sampledb</code> (port 5432).
        </p>

        <label>
          Database
          <input
            value={form.database}
            onChange={(e) => update("database", e.target.value)}
            placeholder={form.db_type === "mysql" ? "e.g. Rfam" : "e.g. sampledb"}
          />
        </label>
        {dbLooksLikeHost && (
          <p className="hint hint-warning">
            This looks like a hostname. The database name is usually something like{" "}
            <code>Rfam</code> or <code>sales</code>.
          </p>
        )}

        <div className="row">
          <label className="grow">
            Username
            <input
              value={form.username}
              onChange={(e) => update("username", e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="grow">
            Password
            <input
              type="password"
              value={form.password}
              onChange={(e) => update("password", e.target.value)}
              placeholder={
                form.noPassword
                  ? "No password"
                  : isEdit
                    ? "Leave empty to keep current"
                    : "Leave empty if there is no password"
              }
              disabled={form.noPassword}
              autoComplete="new-password"
            />
          </label>
        </div>
        {isEdit && (
          <div className="password-row">
            <span className="muted small">
              Current password: <strong>{savedHasPassword ? "set" : "none"}</strong>
            </span>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.noPassword}
                onChange={(e) => setNoPassword(e.target.checked)}
              />
              No password
            </label>
          </div>
        )}

        <label>
          Extra options <span className="muted">(optional JSON, passed to the driver)</span>
          <textarea
            value={form.extra}
            onChange={(e) => update("extra", e.target.value)}
            placeholder={EXTRA_OPTIONS_EXAMPLES[form.db_type]}
            rows={2}
            className="mono"
          />
        </label>
        <p className="hint">
          {form.db_type === "mysql" ? (
            <>
              PyMySQL options, e.g. <code>{EXTRA_OPTIONS_EXAMPLES.mysql}</code> or{" "}
              <code>{'{"charset": "utf8mb4"}'}</code>.
            </>
          ) : (
            <>
              libpq options, e.g. <code>{EXTRA_OPTIONS_EXAMPLES.postgresql}</code>.
            </>
          )}{" "}
          File paths are inside the backend container.
        </p>

        {testResult && <TestResultMessage result={testResult} />}
        {error && <p className="alert alert-error">{error}</p>}

        <div className="form-actions">
          <button type="button" onClick={() => void handleTest()} disabled={busy !== null}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <span className="spacer" />
          <Link to={projectPath("/connections")} className="button">
            Cancel
          </Link>
          <button type="submit" className="primary magnetic" disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
