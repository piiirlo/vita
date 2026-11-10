import { useState } from "react";
import type { ColumnSettings, DatasetColumn, GenericType } from "../api.ts";
import { GENERIC_TYPES } from "./format.ts";
import ValueLabelsDialog from "./ValueLabelsDialog.tsx";

type Props = {
  columns: DatasetColumn[];
  settings: Record<number, ColumnSettings>;
  mainTimeColumn: string | null;
  removed: Set<number>;
  onChange(id: number, patch: Partial<ColumnSettings>): void;
  onMainTimeColumn(name: string | null): void;
  onRemove(id: number): void;
};

/** Editable column metadata. Changes are kept in the page's draft until "Save". */
export default function ColumnsTab({
  columns,
  settings,
  mainTimeColumn,
  removed,
  onChange,
  onMainTimeColumn,
  onRemove,
}: Props) {
  const visible = columns.filter((c) => !removed.has(c.id));
  const missing = visible.filter((c) => c.is_missing).length;
  const [labelling, setLabelling] = useState<DatasetColumn | null>(null);

  return (
    <div>
      {missing > 0 && (
        <p className="alert alert-warning">
          {missing === 1 ? "1 column was" : `${missing} columns were`} not found in the database at the
          last sync. Their settings are kept in case they come back; remove them if they are gone for
          good.
        </p>
      )}
      <div className="table-scroll">
        <table className="data-table columns-table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Label</th>
              <th>Type</th>
              <th title="A date or time column; can be used as a time axis">Temporal</th>
              <th title="Can be used to group by">Dimension</th>
              <th title="Hidden from the chart builder">Hidden</th>
              <th title="The default time column for charts">Main time</th>
              <th>Description</th>
              <th title="Names shown instead of values (legends, axes, tables)">Value labels</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr className="muted small">
              <td colSpan={6} />
              <td>
                <label className="radio-cell">
                  <input
                    type="radio"
                    name="main-time-column"
                    checked={mainTimeColumn === null}
                    onChange={() => onMainTimeColumn(null)}
                    aria-label="No main time column"
                  />
                  none
                </label>
              </td>
              <td colSpan={3} />
            </tr>
            {visible.map((col) => {
              const s = settings[col.id];
              if (!s) return null;
              const effective = s.generic_type_override ?? col.generic_type;
              return (
                <tr key={col.id} className={col.is_missing ? "row-missing" : undefined}>
                  <td>
                    <div className="mono">{col.name}</div>
                    <div className="muted small mono" title="Type in the database">
                      {col.raw_type}
                      {col.is_missing && <span className="tag tag-warning">missing</span>}
                    </div>
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      value={s.label ?? ""}
                      placeholder={col.name}
                      aria-label={`Label of ${col.name}`}
                      onChange={(e) => onChange(col.id, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="cell-input"
                      aria-label={`Type of ${col.name}`}
                      value={s.generic_type_override ?? ""}
                      onChange={(e) =>
                        onChange(col.id, {
                          generic_type_override: (e.target.value || null) as GenericType | null,
                        })
                      }
                    >
                      <option value="">{col.generic_type} (detected)</option>
                      {GENERIC_TYPES.filter((t) => t !== col.generic_type).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      aria-label={`${col.name} is temporal`}
                      checked={s.is_temporal}
                      onChange={(e) => {
                        onChange(col.id, { is_temporal: e.target.checked });
                        if (!e.target.checked && mainTimeColumn === col.name) onMainTimeColumn(null);
                      }}
                    />
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      aria-label={`${col.name} is a dimension`}
                      checked={s.is_dimension}
                      onChange={(e) => onChange(col.id, { is_dimension: e.target.checked })}
                    />
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      aria-label={`${col.name} is hidden`}
                      checked={s.is_hidden}
                      onChange={(e) => onChange(col.id, { is_hidden: e.target.checked })}
                    />
                  </td>
                  <td className="center">
                    <input
                      type="radio"
                      name="main-time-column"
                      aria-label={`${col.name} is the main time column`}
                      checked={mainTimeColumn === col.name}
                      disabled={col.is_missing}
                      title={
                        effective === "date" || effective === "datetime" || s.is_temporal
                          ? undefined
                          : "Selecting this marks the column as temporal"
                      }
                      onChange={() => {
                        if (!s.is_temporal) onChange(col.id, { is_temporal: true });
                        onMainTimeColumn(col.name);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      value={s.description ?? ""}
                      aria-label={`Description of ${col.name}`}
                      onChange={(e) => onChange(col.id, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="small"
                      aria-label={`Value labels of ${col.name}`}
                      onClick={() => setLabelling(col)}
                    >
                      {Object.keys(s.value_labels ?? {}).length
                        ? `${Object.keys(s.value_labels ?? {}).length} labels`
                        : "Add"}
                    </button>
                  </td>
                  <td>
                    {col.is_missing && (
                      <button className="small danger" onClick={() => onRemove(col.id)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {labelling && (
        <ValueLabelsDialog
          column={labelling.name}
          labels={settings[labelling.id]?.value_labels ?? {}}
          onSave={(value_labels) => onChange(labelling.id, { value_labels })}
          onClose={() => setLabelling(null)}
        />
      )}
    </div>
  );
}
