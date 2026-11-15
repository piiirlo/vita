import { useEffect, useState } from "react";
import { getSchemaDiagram, listSchemas, type SchemaDiagram } from "../api.ts";
import { ErrorAlert } from "../components/ui/alert.tsx";
import { SkeletonLines } from "../components/ui/skeleton.tsx";
import { errorText } from "../datasets/format.ts";
import type { SetupDraft } from "./draft.ts";
import { fileDiagram } from "./fileDiagram.ts";
import { markKey, markOf, relations } from "./starterSql.ts";

type Props = {
  draft: SetupDraft;
  onChange(patch: Partial<SetupDraft>): void;
  /** The schema diagram the Query step builds its starter query from. */
  onDiagram(diagram: SchemaDiagram | null): void;
};

const PREFERRED_SCHEMAS = ["public", "dbo"];

/** Step 2, "Look around your data": tables, their columns, and what is a date / a breakdown. */
export default function ExploreStep({ draft, onChange, onDiagram }: Props) {
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [diagram, setDiagram] = useState<SchemaDiagram | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isFile = draft.source === "file";

  // Schemas of a database (a file has its one table).
  useEffect(() => {
    if (isFile || draft.connectionId === null) return;
    listSchemas(draft.connectionId)
      .then((list) => {
        setSchemas(list);
        if (!draft.schema || !list.includes(draft.schema)) {
          onChange({ schema: PREFERRED_SCHEMAS.find((s) => list.includes(s)) ?? list[0] ?? null });
        }
      })
      .catch((err: unknown) => setError(errorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per connection
  }, [isFile, draft.connectionId]);

  useEffect(() => {
    let cancelled = false;
    setDiagram(null);
    onDiagram(null);
    const load = isFile
      ? draft.uploadDatasetId !== null
        ? fileDiagram(draft.uploadDatasetId).then(({ diagram: d, marks }) => {
            if (!cancelled && Object.keys(draft.marks).length === 0) onChange({ marks });
            return d;
          })
        : null
      : draft.connectionId !== null && draft.schema
        ? getSchemaDiagram(draft.connectionId, draft.schema)
        : null;
    load
      ?.then((d) => {
        if (cancelled) return;
        setDiagram(d);
        onDiagram(d);
        if (!draft.table || !d.tables.some((t) => t.name === draft.table)) onChange({ table: d.tables[0]?.name ?? null });
      })
      .catch((err: unknown) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the source or schema changes
  }, [isFile, draft.connectionId, draft.uploadDatasetId, draft.schema]);

  if (error) return <ErrorAlert>{error}</ErrorAlert>;
  if (!diagram) return <SkeletonLines lines={4} label="Reading the tables…" className="max-w-xl" />;

  const table = diagram.tables.find((t) => t.name === draft.table) ?? diagram.tables[0];
  const setMark = (column: string, patch: Partial<{ time: boolean; group: boolean }>) => {
    if (!table) return;
    const col = table.columns.find((c) => c.name === column)!;
    onChange({ marks: { ...draft.marks, [markKey(table.name, column)]: { ...markOf(draft.marks, table.name, col), ...patch } } });
  };

  return (
    <div className="explore">
      <div className="explore-tables">
        {!isFile && schemas && schemas.length > 1 && (
          <label className="field">
            <span>Schema</span>
            <select value={draft.schema ?? ""} onChange={(e) => onChange({ schema: e.target.value, table: null })}>
              {schemas.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
        <div role="group" aria-label="Tables" className="explore-table-list">
          {diagram.tables.length === 0 && <p className="muted small">No tables in this schema.</p>}
          {diagram.tables.map((t) => (
            <button key={t.name} type="button" className="explore-table" aria-pressed={t.name === table?.name} onClick={() => onChange({ table: t.name })}>
              <span>{t.name}</span>
              <small>{t.type === "view" ? "view" : `${t.columns.length} col`}</small>
            </button>
          ))}
        </div>
      </div>
      {table && (
        <div>
          <div className="explore-columns">
            <table>
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Type</th>
                  <th>Time</th>
                  <th>Breakdown</th>
                </tr>
              </thead>
              <tbody>
                {table.columns.map((c) => {
                  const mark = markOf(draft.marks, table.name, c);
                  return (
                    <tr key={c.name}>
                      <td className="mono">{c.name}</td>
                      <td>
                        <span className={`type-chip${mark.time ? " is-time" : ""}`}>{c.type}</span>
                      </td>
                      <td>
                        <label className="checkbox">
                          <input type="checkbox" checked={mark.time} onChange={(e) => setMark(c.name, { time: e.target.checked })} />
                          {mark.time ? "Time column" : "Use as time"}
                        </label>
                      </td>
                      <td>
                        <label className="checkbox">
                          <input type="checkbox" checked={mark.group} onChange={(e) => setMark(c.name, { group: e.target.checked })} />
                          Group by
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!isFile && relations(diagram, table.name).length > 0 && (
            <div className="explore-relations" aria-label="Relations">
              {relations(diagram, table.name).map((r) => (
                <span key={r}>{r}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
