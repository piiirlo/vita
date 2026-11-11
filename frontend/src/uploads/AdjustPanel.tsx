import { ChevronDown, ChevronRight, Lock, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import type { UploadColumnOption, UploadPreview, UploadReadOptions } from "../api.ts";
import { COLUMN_TYPES, DATE_ORDERS, DECIMALS, DELIMITERS, ENCODINGS, sameReadOptions, THOUSANDS, typeLabel, withReadOption } from "./uploads.ts";

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  preview: UploadPreview;
  options: UploadReadOptions;
  onError: "null" | "stop";
  onOnError(mode: "null" | "stop"): void;
  /** Re-read the file with these options. */
  onOptions(options: UploadReadOptions, immediate?: boolean): void;
  /** Change options without re-reading (column names). */
  onLocalOptions(options: UploadReadOptions): void;
};

const detectedMark = (detected: boolean) => (detected ? " (detected)" : "");

const STATUS_BADGE = {
  new: { label: "new", title: "Not in the dataset yet: it will be added as a new column" },
  extra: { label: "not in the dataset", title: "The dataset's table has no such column: leave it out or rename it to match" },
} as const;

/** "Adjust how the file is read": collapsed unless something looks wrong. */
export default function AdjustPanel({ open, onOpenChange, preview, options, onError, onOnError, onOptions, onLocalOptions }: Props) {
  const { detected, problems } = preview;
  const columns = options.columns ?? [];
  const isExcel = preview.file_kind === "xlsx";
  const isDetected = sameReadOptions(options, detected);
  const firstProblemColumn = problems.find((p) => p.column !== null)?.column ?? null;
  const highlighted = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    if (open && firstProblemColumn !== null) highlighted.current?.scrollIntoView({ block: "nearest" });
  }, [open, firstProblemColumn]);

  const setColumn = (index: number, patch: Partial<UploadColumnOption>, reread = true) => {
    const next = { ...options, columns: columns.map((c) => (c.index === index ? { ...c, ...patch } : c)) };
    if (reread) onOptions(next, true);
    else onLocalOptions(next);
  };

  return (
    <section className={`adjust card${open ? " is-open" : ""}`}>
      <button type="button" className="adjust-toggle" aria-expanded={open} aria-controls="adjust-body" onClick={() => onOpenChange(!open)}>
        {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        Adjust how the file is read
        {problems.length > 0 && (
          <span className="adjust-count" aria-label={`${problems.length} ${problems.length === 1 ? "problem" : "problems"}`}>
            <TriangleAlert size={13} aria-hidden /> {problems.length}
          </span>
        )}
      </button>
      {open && (
        <div id="adjust-body" className="adjust-body">
          {problems.length > 0 && (
            <ul className="adjust-problems" aria-label="Problems">
              {problems.map((p, i) => (
                <li key={i} className={p.blocking ? "is-blocking" : ""}>
                  <TriangleAlert size={14} aria-hidden />
                  <span>
                    {p.blocking && <strong>To fix: </strong>}
                    {p.message}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="adjust-grid">
            {isExcel && (
              <label className="control">
                <span>Sheet</span>
                <select aria-label="Sheet" value={options.sheet ?? preview.sheets[0] ?? ""} onChange={(e) => onOptions(withReadOption(options, "sheet", e.target.value), true)}>
                  {preview.sheets.map((name) => (
                    <option key={name} value={name}>
                      {name}
                      {detectedMark(name === detected.sheet)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!isExcel && (
              <>
            <label className="control">
              <span>Delimiter</span>
              <select aria-label="Delimiter" value={options.delimiter} onChange={(e) => onOptions(withReadOption(options, "delimiter", e.target.value as UploadReadOptions["delimiter"]))}>
                {DELIMITERS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                    {detectedMark(d.value === detected.delimiter)}
                  </option>
                ))}
              </select>
            </label>
            <label className="control">
              <span>Encoding</span>
              <select aria-label="Encoding" value={options.encoding} onChange={(e) => onOptions(withReadOption(options, "encoding", e.target.value as UploadReadOptions["encoding"]))}>
                {ENCODINGS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                    {detectedMark(d.value === detected.encoding)}
                  </option>
                ))}
              </select>
            </label>
            <label className="control">
              <span>Decimal separator</span>
              <select aria-label="Decimal separator" value={options.decimal} onChange={(e) => onOptions(withReadOption(options, "decimal", e.target.value as UploadReadOptions["decimal"]))}>
                {DECIMALS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                    {detectedMark(d.value === detected.decimal)}
                  </option>
                ))}
              </select>
            </label>
            <label className="control">
              <span>Thousands separator</span>
              <select aria-label="Thousands separator" value={options.thousands} onChange={(e) => onOptions(withReadOption(options, "thousands", e.target.value as UploadReadOptions["thousands"]))}>
                {THOUSANDS.map((d) => (
                  <option key={d.label} value={d.value}>
                    {d.label}
                    {detectedMark(d.value === detected.thousands)}
                  </option>
                ))}
              </select>
            </label>
              </>
            )}
            <label className="control">
              <span>Rows to skip at the top</span>
              <input
                type="number"
                aria-label="Rows to skip at the top"
                min={0}
                max={1000}
                value={options.skip_rows}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 0 && n <= 1000) onOptions(withReadOption(options, "skip_rows", n));
                }}
              />
            </label>
            <div className="adjust-checks">
              <label className="checkbox">
                <input type="checkbox" checked={options.header} onChange={(e) => onOptions(withReadOption(options, "header", e.target.checked))} />
                First row is the header
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={onError === "stop"} onChange={(e) => onOnError(e.target.checked ? "stop" : "null")} />
                Stop if a value doesn’t fit its type
              </label>
            </div>
            <div className="adjust-reset">
              <button type="button" className="link-button" disabled={isDetected} onClick={() => onOptions(detected, true)}>
                <RotateCcw size={13} aria-hidden /> Reset to detected
              </button>
            </div>
          </div>
          {preview.target && (
            <p className="muted small adjust-target-note">
              <Lock size={12} aria-hidden /> Columns matched by name to <strong>{preview.target.name}</strong> keep the
              dataset’s name and type.
            </p>
          )}

          <table className="adjust-columns">
            <thead>
              <tr>
                <th scope="col">In the file</th>
                <th scope="col">Column name</th>
                <th scope="col">Type</th>
                <th scope="col">Dates</th>
                <th scope="col">Values that don’t fit</th>
                <th scope="col">Leave out</th>
              </tr>
            </thead>
            <tbody>
              {preview.columns.map((c) => {
                const option = columns.find((o) => o.index === c.index);
                const problem = problems.find((p) => p.column === c.index);
                const isDate = (option?.type ?? c.type) === "date" || (option?.type ?? c.type) === "datetime";
                return (
                  <tr
                    key={c.index}
                    ref={c.index === firstProblemColumn ? highlighted : undefined}
                    className={`${problem ? "has-problem" : ""}${c.ignore ? " is-ignored" : ""}`}
                    aria-label={problem ? `${c.source_name}: ${problem.message}` : undefined}
                  >
                    <td className="mono small" title={c.source_name}>
                      {c.source_name || <span className="muted">(no header)</span>}
                      {c.status && c.status !== "matched" && (
                        <span className={`column-status is-${c.status}`} title={STATUS_BADGE[c.status].title}>
                          {STATUS_BADGE[c.status].label}
                        </span>
                      )}
                    </td>
                    <td>
                      <input
                        aria-label={`Name of ${c.source_name || `column ${c.index + 1}`}`}
                        value={option?.name ?? c.name}
                        maxLength={63}
                        readOnly={c.locked}
                        title={c.locked ? "Kept from the dataset" : undefined}
                        // Renaming can match a column of the dataset: re-read (debounced) on replace / append.
                        onChange={(e) => (preview.target ? onOptions({ ...options, columns: columns.map((o) => (o.index === c.index ? { ...o, name: e.target.value } : o)) }) : setColumn(c.index, { name: e.target.value }, false))}
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`Type of ${c.source_name || `column ${c.index + 1}`}`}
                        value={option?.type ?? c.type}
                        disabled={c.locked}
                        title={c.locked ? "Kept from the dataset" : undefined}
                        onChange={(e) => setColumn(c.index, { type: e.target.value as UploadColumnOption["type"] })}
                      >
                        {COLUMN_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                            {!c.locked && t.value === c.guessed_type ? " (guess)" : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {isDate ? (
                        <select
                          aria-label={`Date order of ${c.source_name || `column ${c.index + 1}`}`}
                          value={option?.date_order ?? ""}
                          className={c.date_ambiguous && !option?.date_order ? "needs-answer" : ""}
                          aria-invalid={c.date_ambiguous && !option?.date_order ? true : undefined}
                          onChange={(e) => setColumn(c.index, { date_order: (e.target.value || null) as UploadColumnOption["date_order"] })}
                        >
                          {!option?.date_order && <option value="">Which order?</option>}
                          {DATE_ORDERS.map((d) => (
                            <option key={d.value} value={d.value}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                    <td className="small">
                      {c.misfits > 0 ? (
                        <span className="misfits">
                          <TriangleAlert size={13} aria-hidden /> {c.misfits.toLocaleString("en-US")} of {c.checked.toLocaleString("en-US")} aren’t{" "}
                          {typeLabel(c.type).toLowerCase()}: {c.examples.slice(0, 3).map((e) => `“${e.value}”`).join(", ")}
                        </span>
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Leave out ${c.source_name || `column ${c.index + 1}`}`}
                        checked={option?.ignore ?? c.ignore}
                        onChange={(e) => setColumn(c.index, { ignore: e.target.checked })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

