import { Check, Database, FileText } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { createConnection, getConnection, getDataset, testConnectionDetails, type Connection, type DbType } from "../api.ts";
import { ErrorAlert } from "../components/ui/alert.tsx";
import { SkeletonLines } from "../components/ui/skeleton.tsx";
import { EMPTY_FORM, portAfterTypeChange, toFields, type FormState } from "../connections/connectionForm.ts";
import { errorText } from "../datasets/format.ts";
import type { SetupDraft } from "./draft.ts";

const UploadPage = lazy(() => import("../pages/UploadPage.tsx"));

const DB_NAMES: Record<DbType, string> = { postgresql: "PostgreSQL", mysql: "MySQL" };

type Props = {
  draft: SetupDraft;
  onChange(patch: Partial<SetupDraft>): void;
};

/** Step 1, "Where does your data live?": a database (tested, then saved in the project) or a
 * file (uploaded into the Uploads database; it becomes a dataset). */
export default function SourceStep({ draft, onChange }: Props) {
  return (
    <>
      <div className="choices">
        <button
          type="button"
          className="choice"
          aria-pressed={draft.source === "db"}
          onClick={() => onChange({ source: "db", connectionId: draft.source === "db" ? draft.connectionId : null, uploadDatasetId: null })}
        >
          <span className="choice-icon" aria-hidden>
            <Database size={22} />
          </span>
          <span>
            <strong>Connect a database</strong>
            <small>PostgreSQL or MySQL. Vita only reads, never changes your data.</small>
          </span>
        </button>
        <button
          type="button"
          className="choice"
          aria-pressed={draft.source === "file"}
          onClick={() => onChange({ source: "file", connectionId: draft.source === "file" ? draft.connectionId : null })}
        >
          <span className="choice-icon" aria-hidden>
            <FileText size={22} />
          </span>
          <span>
            <strong>Upload a file</strong>
            <small>CSV or Excel. It becomes a table you can query.</small>
          </span>
        </button>
      </div>
      {draft.source === "db" && <DatabaseSource draft={draft} onChange={onChange} />}
      {draft.source === "file" && <FileSource draft={draft} onChange={onChange} />}
    </>
  );
}

function Connected({ title, detail, onReplace, replaceLabel }: { title: string; detail: string; onReplace?(): void; replaceLabel?: string }) {
  return (
    <div className="setup-ok" role="status">
      <span className="setup-ok-check" aria-hidden>
        <Check size={16} strokeWidth={3} />
      </span>
      <div className="min-w-0 flex-1">
        <strong>{title}</strong>
        <br />
        <small className="muted">{detail}</small>
      </div>
      {onReplace && (
        <button type="button" className="ghost small" onClick={onReplace}>
          {replaceLabel}
        </button>
      )}
    </div>
  );
}

function DatabaseSource({ draft, onChange }: Props) {
  const [saved, setSaved] = useState<Connection | null>(null);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [busy, setBusy] = useState<"test" | null>(null);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (draft.connectionId === null) return setSaved(null);
    if (saved?.id === draft.connectionId) return;
    getConnection(draft.connectionId)
      .then(setSaved)
      .catch(() => onChange({ connectionId: null }));
  }, [draft.connectionId, saved, onChange]);

  if (draft.connectionId !== null) {
    if (!saved) return <SkeletonLines lines={1} label="Loading the connection…" className="mt-5 max-w-md" />;
    return (
      <Connected
        title="Connected"
        detail={`${saved.name} · ${DB_NAMES[saved.db_type]} · read-only access`}
        onReplace={() => onChange({ connectionId: null, schema: null, table: null, marks: {}, sql: null })}
        replaceLabel="Use another database"
      />
    );
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setTested(false);
    setError(null);
  }

  /** Test, then save the connection in the project (the password is stored encrypted on the
   * server, never in the draft). */
  async function testAndSave() {
    setError(null);
    let fields;
    try {
      fields = toFields(form);
    } catch (err) {
      setError(errorText(err));
      return;
    }
    setBusy("test");
    try {
      const result = await testConnectionDetails(fields);
      if (!result.ok) {
        setError(result.error ?? "Couldn't connect.");
        return;
      }
      setTested(true);
      const base = form.name.trim() || fields.database;
      let created: Connection | null = null;
      for (let n = 1; !created && n < 20; n++) {
        try {
          created = await createConnection({ ...fields, name: n === 1 ? base : `${base} (${n})` });
        } catch (err) {
          if (!/already exists/i.test(errorText(err))) throw err;
        }
      }
      if (created) {
        setSaved(created);
        onChange({ connectionId: created.id, schema: null, table: null, marks: {}, sql: null });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="setup-form">
        <label className="field">
          <span>Database type</span>
          <select
            value={form.db_type}
            onChange={(e) => {
              const to = e.target.value as DbType;
              setForm((f) => ({ ...f, db_type: to, port: portAfterTypeChange(f.port, f.db_type, to) }));
            }}
          >
            <option value="postgresql">PostgreSQL</option>
            <option value="mysql">MySQL</option>
          </select>
        </label>
        <label className="field">
          <span>Host</span>
          <input value={form.host} onChange={(e) => update("host", e.target.value)} placeholder="db.mycompany.local" autoComplete="off" />
        </label>
        <label className="field">
          <span>Port</span>
          <input value={form.port} onChange={(e) => update("port", e.target.value)} inputMode="numeric" />
        </label>
        <label className="field">
          <span>Database</span>
          <input value={form.database} onChange={(e) => update("database", e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>User</span>
          <input value={form.username} onChange={(e) => update("username", e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" value={form.password} onChange={(e) => update("password", e.target.value)} autoComplete="new-password" />
        </label>
        <label className="field">
          <span>Name in Vita</span>
          <input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="The database's name" autoComplete="off" />
        </label>
        <div className="field setup-test">
          <button type="button" className="sand pill" onClick={() => void testAndSave()} disabled={busy !== null}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
        </div>
      </div>
      {tested && !error && <p className="muted small">Connected. Saving it in the project…</p>}
      {error && <ErrorAlert className="mt-4">{error}</ErrorAlert>}
    </>
  );
}

function FileSource({ draft, onChange }: Props) {
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (draft.uploadDatasetId === null) return;
    getDataset(draft.uploadDatasetId)
      .then((d) => setLabel(`${d.name} · ${d.columns.filter((c) => !c.is_missing).length} columns · table ${d.table_name ?? ""}`))
      .catch((err: unknown) => setError(errorText(err)));
  }, [draft.uploadDatasetId]);

  if (draft.uploadDatasetId !== null) {
    if (error) return <ErrorAlert className="mt-4">{error}</ErrorAlert>;
    return (
      <Connected
        title={label ? "Uploaded" : "Loading…"}
        detail={label ?? ""}
        onReplace={() => onChange({ uploadDatasetId: null, connectionId: null, table: null, marks: {}, sql: null })}
        replaceLabel="Upload another file"
      />
    );
  }
  return (
    <div className="setup-upload">
      <Suspense fallback={<SkeletonLines lines={2} label="Loading…" />}>
        <UploadPage
          embedded
          onCreated={(datasetId) => {
            void getDataset(datasetId).then((d) =>
              onChange({ uploadDatasetId: d.id, connectionId: d.connection_id, schema: d.schema, table: d.table_name, marks: {}, sql: null }),
            );
          }}
        />
      </Suspense>
    </div>
  );
}
