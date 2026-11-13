import { useState, type FormEvent } from "react";
import {
  ApiError,
  createMetric,
  deleteMetric,
  isQueryErrorDetail,
  updateMetric,
  validateMetric,
  type DatasetMetric,
  type MetricInput,
  type MetricValidation,
} from "../api.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { QueryErrorBody } from "../components/QueryErrorAlert.tsx";
import { cellText } from "../sqllab/results.ts";
import { errorText, NUMBER_FORMATS } from "./format.ts";

type Props = {
  datasetId: number;
  metrics: DatasetMetric[];
  onChanged(): void;
};

type Draft = { id: number | null; builtin: boolean } & MetricInput;

const EMPTY: Draft = {
  id: null,
  builtin: false,
  name: "",
  label: "",
  expression: "",
  description: "",
  number_format: "",
};

function draftOf(metric: DatasetMetric): Draft {
  return {
    id: metric.id,
    builtin: metric.is_builtin,
    name: metric.name,
    label: metric.label ?? "",
    expression: metric.expression,
    description: metric.description ?? "",
    number_format: metric.number_format ?? "",
  };
}

/** Metrics are saved one at a time (not with the page's Save button). */
export default function MetricsTab({ datasetId, metrics, onChanged }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [validation, setValidation] = useState<MetricValidation | "running" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<DatasetMetric | null>(null);

  function edit(next: Draft | null) {
    setDraft(next);
    setValidation(null);
    setError(null);
  }

  function patch(changes: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...changes } : d));
    if ("expression" in changes) setValidation(null);
  }

  async function validate() {
    if (!draft) return;
    setValidation("running");
    try {
      setValidation(await validateMetric(datasetId, draft.expression));
    } catch (err) {
      setValidation({
        ok: false,
        error: { kind: "other", message: errorText(err), line: null, column: null },
        warning: null,
        value: null,
      });
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!draft.name.trim() || !draft.expression.trim()) {
      setError("Name and expression are required.");
      return;
    }
    const input: MetricInput = {
      name: draft.name.trim(),
      label: draft.label?.trim() || null,
      expression: draft.expression.trim(),
      description: draft.description?.trim() || null,
      number_format: draft.number_format?.trim() || null,
    };
    setSaving(true);
    setError(null);
    try {
      if (draft.id === null) await createMetric(datasetId, input);
      else await updateMetric(datasetId, draft.id, input);
      edit(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError && isQueryErrorDetail(err.detail) ? err.detail.message : errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete(metric: DatasetMetric) {
    await deleteMetric(datasetId, metric.id);
    setToDelete(null);
    if (draft?.id === metric.id) edit(null);
    onChanged();
  }

  return (
    <div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Label</th>
            <th>Expression</th>
            <th>Format</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => (
            <tr key={m.id} className={draft?.id === m.id ? "row-selected" : undefined}>
              <td className="mono">
                {m.name} {m.is_builtin && <span className="tag">built-in</span>}
                {m.description && <div className="muted small">{m.description}</div>}
              </td>
              <td>{m.label ?? <span className="muted">—</span>}</td>
              <td className="mono small">{m.expression}</td>
              <td className="mono small">{m.number_format ?? <span className="muted">—</span>}</td>
              <td className="actions">
                <button className="small" onClick={() => edit(draftOf(m))}>
                  Edit
                </button>
                {!m.is_builtin && (
                  <button className="small danger" onClick={() => setToDelete(m)}>
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!draft && (
        <p>
          <button onClick={() => edit({ ...EMPTY })}>+ Add metric</button>
        </p>
      )}

      {draft && (
        <form className="card form metric-form" onSubmit={(e) => void save(e)} aria-label="Metric">
          <h2 className="modal-title">{draft.id === null ? "New metric" : `Edit metric “${draft.name}”`}</h2>
          <div className="row">
            <label>
              Name
              <input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                disabled={draft.builtin}
                placeholder="revenue"
                autoFocus={!draft.builtin}
              />
            </label>
            <label>
              Label <span className="muted">(optional)</span>
              <input value={draft.label ?? ""} onChange={(e) => patch({ label: e.target.value })} placeholder="Revenue" />
            </label>
          </div>
          <label>
            SQL expression
            <textarea
              className="mono"
              rows={3}
              value={draft.expression}
              onChange={(e) => patch({ expression: e.target.value })}
              disabled={draft.builtin}
              placeholder="SUM(quantity * unit_price)"
              spellCheck={false}
            />
            {draft.builtin && <span className="muted small">The built-in count metric’s expression is fixed.</span>}
          </label>
          <div className="validate-row">
            <button type="button" onClick={() => void validate()} disabled={!draft.expression.trim() || validation === "running"}>
              {validation === "running" ? "Validating…" : "Validate"}
            </button>
            {validation && validation !== "running" && <ValidationMessage result={validation} />}
          </div>
          <div className="row">
            <label>
              Number format <span className="muted">(optional)</span>
              <input
                className="mono"
                list="number-formats"
                value={draft.number_format ?? ""}
                onChange={(e) => patch({ number_format: e.target.value })}
                placeholder="0,0.00"
              />
              <datalist id="number-formats">
                {NUMBER_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.hint}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              Description <span className="muted">(optional)</span>
              <input value={draft.description ?? ""} onChange={(e) => patch({ description: e.target.value })} />
            </label>
          </div>
          {error && <p className="alert alert-error">{error}</p>}
          <div className="form-actions">
            <span className="spacer" />
            <button type="button" onClick={() => edit(null)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? "Saving…" : "Save metric"}
            </button>
          </div>
        </form>
      )}

      {toDelete && (
        <ConfirmDialog
          title="Delete metric"
          confirmLabel="Delete"
          onConfirm={() => confirmDelete(toDelete)}
          onCancel={() => setToDelete(null)}
        >
          <p>
            Delete the metric <strong className="mono">{toDelete.name}</strong>?
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ValidationMessage({ result }: { result: MetricValidation }) {
  if (!result.ok) {
    return (
      <div className="text-error" role="status">
        {result.error ? (
          <>
            <span aria-hidden>✗ </span>
            <QueryErrorBody error={result.error} />
          </>
        ) : (
          "✗ The expression failed."
        )}
      </div>
    );
  }
  return (
    <span role="status">
      <span className="text-ok">✓ Valid</span>
      <span className="muted"> · value on the whole dataset: </span>
      <span className="mono">{cellText(result.value)}</span>
      {result.warning && <div className="text-warning small">{result.warning}</div>}
    </span>
  );
}
