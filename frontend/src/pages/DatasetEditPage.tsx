import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  ApiError,
  deleteDataset,
  getDataset,
  isQueryErrorDetail,
  syncDataset,
  updateDataset,
  type ColumnSettings,
  type Dataset,
  type SyncResponse,
} from "../api.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import ColumnsTab from "../datasets/ColumnsTab.tsx";
import { errorText } from "../datasets/format.ts";
import MetricsTab from "../datasets/MetricsTab.tsx";
import PreviewTab from "../datasets/PreviewTab.tsx";
import { openDatasetInSqlLab } from "../datasets/sqlLabLink.ts";

type TabName = "columns" | "metrics" | "preview";

type Draft = {
  name: string;
  description: string;
  mainTimeColumn: string | null;
  columns: Record<number, ColumnSettings>;
  removed: Set<number>;
};

function draftOf(dataset: Dataset): Draft {
  const columns: Record<number, ColumnSettings> = {};
  for (const c of dataset.columns) {
    columns[c.id] = {
      id: c.id,
      label: c.label,
      generic_type_override: c.generic_type_override,
      is_temporal: c.is_temporal,
      is_dimension: c.is_dimension,
      is_hidden: c.is_hidden,
      description: c.description,
    };
  }
  return {
    name: dataset.name,
    description: dataset.description ?? "",
    mainTimeColumn: dataset.main_time_column,
    columns,
    removed: new Set(),
  };
}

const norm = (text: string | null) => (text ?? "").trim();

function sameSettings(a: ColumnSettings, b: ColumnSettings): boolean {
  return (
    norm(a.label) === norm(b.label) &&
    norm(a.description) === norm(b.description) &&
    a.generic_type_override === b.generic_type_override &&
    a.is_temporal === b.is_temporal &&
    a.is_dimension === b.is_dimension &&
    a.is_hidden === b.is_hidden
  );
}

function changedColumns(draft: Draft, saved: Draft): ColumnSettings[] {
  return Object.values(draft.columns).filter((c) => {
    const before = saved.columns[c.id];
    return !draft.removed.has(c.id) && before !== undefined && !sameSettings(c, before);
  });
}

function syncMessage({ summary }: SyncResponse): string {
  const parts: string[] = [];
  if (summary.added.length) parts.push(`added ${summary.added.join(", ")}`);
  if (summary.removed.length) parts.push(`missing now: ${summary.removed.join(", ")}`);
  if (summary.restored.length) parts.push(`back again: ${summary.restored.join(", ")}`);
  if (summary.type_changed.length) parts.push(`type changed: ${summary.type_changed.join(", ")}`);
  return parts.length ? `Synced: ${parts.join("; ")}.` : "Synced: no changes.";
}

export default function DatasetEditPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<TabName>("columns");
  const [busy, setBusy] = useState<"save" | "sync" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  const loaded = useCallback((data: Dataset) => {
    setDataset(data);
    setDraft(draftOf(data));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getDataset(id)
      .then((data) => !cancelled && loaded(data))
      .catch((err: unknown) => !cancelled && setLoadError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [id, loaded]);

  const saved = useMemo(() => (dataset ? draftOf(dataset) : null), [dataset]);
  const dirty = useMemo(() => {
    if (!draft || !saved) return false;
    return (
      norm(draft.name) !== norm(saved.name) ||
      norm(draft.description) !== norm(saved.description) ||
      draft.mainTimeColumn !== saved.mainTimeColumn ||
      draft.removed.size > 0 ||
      changedColumns(draft, saved).length > 0
    );
  }, [draft, saved]);

  // Warn before leaving the page with unsaved column changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  if (loadError) {
    return (
      <div>
        <p className="alert alert-error">{loadError}</p>
        <Link to="/datasets">Back to datasets</Link>
      </div>
    );
  }
  if (!dataset || !draft || !saved) return <p className="muted">Loading…</p>;

  function flash(text: string) {
    setNotice(text);
    setError(null);
  }

  function fail(err: unknown) {
    setNotice(null);
    setError(err instanceof ApiError && isQueryErrorDetail(err.detail) ? err.detail.message : errorText(err));
  }

  async function save() {
    if (!dataset || !draft || !saved) return;
    if (!draft.name.trim()) {
      setError("The dataset needs a name.");
      return;
    }
    setBusy("save");
    try {
      const updated = await updateDataset(dataset.id, {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        main_time_column: draft.mainTimeColumn,
        columns: changedColumns(draft, saved),
        delete_column_ids: [...draft.removed],
      });
      loaded(updated);
      setPreviewKey((k) => k + 1);
      flash("Saved.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    if (!dataset) return;
    setBusy("sync");
    try {
      const result = await syncDataset(dataset.id);
      loaded(result.dataset);
      setPreviewKey((k) => k + 1);
      flash(syncMessage(result));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function reloadMetrics() {
    if (!dataset) return;
    try {
      const fresh = await getDataset(dataset.id);
      setDataset((prev) => (prev ? { ...prev, metrics: fresh.metrics, updated_at: fresh.updated_at } : fresh));
    } catch (err) {
      fail(err);
    }
  }

  async function remove() {
    if (!dataset) return;
    await deleteDataset(dataset.id);
    navigate("/datasets");
  }

  const update = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const activeColumns = dataset.columns.filter((c) => !c.is_missing).length;

  return (
    <div className="dataset-page">
      <div className="page-header">
        <h1>
          <Link to="/datasets" className="crumb">
            Datasets
          </Link>{" "}
          / {dataset.name}
        </h1>
        <div className="actions">
          <Link to={`/charts/new?dataset=${dataset.id}`} className="button primary">
            Create chart
          </Link>
          <button onClick={() => navigate("/sql-lab", { state: openDatasetInSqlLab(dataset) })}>
            Open in SQL Lab
          </button>
          <button className="danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        </div>
      </div>

      <div className="card form dataset-details">
        <div className="row">
          <label>
            Name
            <input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
          </label>
          <label>
            Description
            <input value={draft.description} onChange={(e) => update({ description: e.target.value })} />
          </label>
        </div>
        <div className="dataset-source small">
          <span className="muted">Connection</span> {dataset.connection_name}
          <span className="muted"> · Source </span>
          {dataset.kind === "table" ? (
            <span className="mono">
              {dataset.schema}.{dataset.table_name}
            </span>
          ) : (
            <span>SQL query</span>
          )}
        </div>
        {dataset.kind === "sql" && (
          <details className="dataset-sql">
            <summary className="small">Show SQL</summary>
            <pre className="mono small">{dataset.sql}</pre>
          </details>
        )}
        {dataset.warnings.map((w) => (
          <p key={w} className="alert alert-warning small">
            {w}
          </p>
        ))}
      </div>

      <div className="dataset-tabs" role="tablist">
        {(
          [
            ["columns", `Columns (${activeColumns})`],
            ["metrics", `Metrics (${dataset.metrics.length})`],
            ["preview", "Preview"],
          ] as const
        ).map(([name, label]) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "active" : ""}
            onClick={() => setTab(name)}
          >
            {label}
          </button>
        ))}
        <span className="spacer" />
        {tab === "columns" && (
          <button
            onClick={() => void sync()}
            disabled={busy !== null || dirty}
            title={dirty ? "Save or discard your changes first" : "Read the columns from the database again"}
          >
            {busy === "sync" ? "Syncing…" : "Sync columns"}
          </button>
        )}
        <button onClick={() => setDraft(draftOf(dataset))} disabled={!dirty || busy !== null}>
          Discard
        </button>
        <button
          className="primary"
          onClick={() => void save()}
          disabled={!dirty || busy !== null}
          title="Saves the name, description and column settings (metrics are saved separately)"
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </div>

      {error && <p className="alert alert-error">{error}</p>}
      {notice && !error && <p className="alert alert-ok">{notice}</p>}

      {tab === "columns" && (
        <ColumnsTab
          columns={dataset.columns}
          settings={draft.columns}
          mainTimeColumn={draft.mainTimeColumn}
          removed={draft.removed}
          onChange={(colId, patch) => {
            const current = draft.columns[colId];
            if (current) update({ columns: { ...draft.columns, [colId]: { ...current, ...patch } } });
          }}
          onMainTimeColumn={(name) => update({ mainTimeColumn: name })}
          onRemove={(colId) => {
            const col = dataset.columns.find((c) => c.id === colId);
            update({
              removed: new Set([...draft.removed, colId]),
              mainTimeColumn: col && draft.mainTimeColumn === col.name ? null : draft.mainTimeColumn,
            });
          }}
        />
      )}
      {tab === "metrics" && (
        <MetricsTab datasetId={dataset.id} metrics={dataset.metrics} onChanged={() => void reloadMetrics()} />
      )}
      {tab === "preview" && <PreviewTab datasetId={dataset.id} title={dataset.name} reloadKey={previewKey} />}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete dataset"
          confirmLabel="Delete"
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        >
          <p>
            Delete <strong>{dataset.name}</strong> with its column settings and metrics? This cannot be
            undone. The table or query in the database is not affected.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
