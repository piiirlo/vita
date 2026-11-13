import { useId, useRef, useState, type KeyboardEvent } from "react";
import { validateMetric, type Dataset, type MetricValidation, type SqlMetric } from "../api.ts";
import { QueryErrorBody } from "../components/QueryErrorAlert.tsx";
import { toQueryError } from "../components/queryError.ts";
import { NUMBER_FORMATS } from "../datasets/format.ts";
import { cellText } from "../sqllab/results.ts";
import { applyCompletion, sqlCompletions, type Completions } from "./sqlMetric.ts";

type Props = {
  dataset: Dataset;
  /** Names already used by the chart's metrics (a label must be new). */
  taken: string[];
  /** "Use" (one metric) or "Add". */
  single?: boolean;
  onAdd(metric: SqlMetric): void;
};

/** A custom SQL metric: label, expression (with column autocomplete), number format and
 * Validate (the same checks as a saved metric, run on the dataset). */
export default function SqlMetricEditor({ dataset, taken, single, onAdd }: Props) {
  const [label, setLabel] = useState("");
  const [sql, setSql] = useState("");
  const [format, setFormat] = useState("");
  const [validation, setValidation] = useState<MetricValidation | "running" | null>(null);
  const [completions, setCompletions] = useState<Completions | null>(null);
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const labelTaken = taken.some((t) => t.toLowerCase() === label.trim().toLowerCase());

  function suggest(text: string, cursor: number) {
    setCompletions(sqlCompletions(text, cursor, dataset.columns, dataset.db_type));
    setActive(0);
  }

  function accept(index: number) {
    if (!completions) return;
    const item = completions.items[index];
    if (!item) return;
    const next = applyCompletion(sql, completions, item);
    setSql(next.text);
    setCompletions(null);
    setValidation(null);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!completions) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = completions.items.length;
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setCompletions(null);
    }
  }

  async function validate() {
    setValidation("running");
    try {
      setValidation(await validateMetric(dataset.id, sql));
    } catch (err) {
      setValidation({ ok: false, error: toQueryError(err), warning: null, value: null });
    }
  }

  const ready = Boolean(sql.trim() && label.trim()) && !labelTaken;
  return (
    <div className="sql-metric">
      <label className="control">
        <span>Label</span>
        <input aria-label="Custom metric label" value={label} maxLength={255} placeholder="e.g. Price per unit" onChange={(e) => setLabel(e.target.value)} />
      </label>
      {labelTaken && <p className="control-hint">The chart already has a metric with this name.</p>}
      <div className="control sql-metric-expression">
        <span>SQL expression</span>
        <textarea
          ref={area}
          aria-label="Custom metric SQL"
          className="mono"
          rows={3}
          spellCheck={false}
          placeholder="SUM(amount) / NULLIF(SUM(quantity), 0)"
          value={sql}
          role="combobox"
          aria-expanded={Boolean(completions)}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={completions ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setSql(e.target.value);
            setValidation(null);
            suggest(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setCompletions(null)}
        />
        {completions && (
          <ul id={listId} role="listbox" aria-label="Columns and functions" className="sql-completions">
            {completions.items.map((item, i) => (
              <li
                key={`${item.kind}:${item.label}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "is-active" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep the textarea focused
                  accept(i);
                }}
              >
                <span className="mono">{item.label}</span>
                <span className="muted small">{item.kind === "function" ? "function" : item.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="control">
        <span>Number format</span>
        <select aria-label="Custom metric number format" value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="">Default</option>
          {NUMBER_FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.value} ({f.hint})
            </option>
          ))}
        </select>
      </label>
      <div className="inline-controls">
        <button type="button" className="small" disabled={!sql.trim() || validation === "running"} onClick={() => void validate()}>
          {validation === "running" ? "Validating…" : "Validate"}
        </button>
        <button
          type="button"
          className="small"
          disabled={!ready}
          onClick={() => {
            onAdd({ sql: sql.trim(), label: label.trim(), ...(format ? { number_format: format } : {}) });
            setSql("");
            setLabel("");
            setFormat("");
            setValidation(null);
          }}
        >
          {single ? "Use" : "Add"}
        </button>
      </div>
      {validation && validation !== "running" && (
        <div role="status" className={`small ${validation.ok ? "" : "text-error"}`}>
          {validation.ok ? (
            <>
              <span className="text-ok">✓ Valid</span>
              <span className="muted"> · value on the whole dataset: </span>
              <span className="mono">{cellText(validation.value)}</span>
              {validation.warning && <div className="text-warning">{validation.warning}</div>}
            </>
          ) : validation.error ? (
            <QueryErrorBody error={validation.error} />
          ) : (
            "The expression failed."
          )}
        </div>
      )}
    </div>
  );
}
