import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Modal, ModalActions } from "../components/ui/dialog.tsx";

type Row = { value: string; label: string };

/** Edit a column's value labels ("1" -> "Lethbridge"): shown in legends, axes and tables
 * instead of the raw values. */
export default function ValueLabelsDialog({
  column,
  labels,
  onSave,
  onClose,
}: {
  column: string;
  labels: Record<string, string>;
  onSave(labels: Record<string, string>): void;
  onClose(): void;
}) {
  const [rows, setRows] = useState<Row[]>(() => {
    const entries = Object.entries(labels).map(([value, label]) => ({ value, label }));
    return entries.length ? entries : [{ value: "", label: "" }];
  });
  const set = (i: number, patch: Partial<Row>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const duplicates = new Set(rows.map((r) => r.value.trim()).filter((v, i, all) => v && all.indexOf(v) !== i));

  function save() {
    const result: Record<string, string> = {};
    for (const r of rows) if (r.value.trim() && r.label.trim()) result[r.value.trim()] = r.label.trim();
    onSave(result);
    onClose();
  }

  return (
    <Modal title={<>Value labels of “{column}”</>} label={`Value labels of ${column}`} onClose={onClose} onSubmit={save}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Show a name instead of a value in legends, axes and tables, e.g. store <span className="mono">1</span> →
        Lethbridge.
      </p>
      <div className="value-labels">
        <div className="value-labels-head eyebrow">
          <span>Value</span>
          <span>Shown as</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div key={i} className="value-labels-row">
            <input
              className="cell-input mono"
              aria-label={`Value ${i + 1}`}
              value={row.value}
              placeholder="1"
              onChange={(e) => set(i, { value: e.target.value })}
              aria-invalid={duplicates.has(row.value.trim()) || undefined}
            />
            <input
              className="cell-input"
              aria-label={`Label for value ${i + 1}`}
              value={row.label}
              placeholder="Lethbridge"
              onChange={(e) => set(i, { label: e.target.value })}
            />
            <button type="button" className="icon small" aria-label={`Remove value ${i + 1}`} onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
      </div>
      {duplicates.size > 0 && <p className="alert alert-error compact">The same value is listed twice; only the last label is kept.</p>}
      <button type="button" className="small" onClick={() => setRows((r) => [...r, { value: "", label: "" }])}>
        <Plus size={14} aria-hidden /> Add value
      </button>
      <ModalActions>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Apply
        </button>
      </ModalActions>
    </Modal>
  );
}
