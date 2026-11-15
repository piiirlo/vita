import { useEffect, useMemo, useState } from "react";
import { runQuery, type Connection, type DatasetListItem, type QueryErrorDetail, type QueryResult, type SchemaDiagram } from "../api.ts";
import { QueryErrorAlert } from "../components/QueryErrorAlert.tsx";
import { toQueryError } from "../components/queryError.ts";
import { cellText } from "../sqllab/results.ts";
import type { SetupDraft } from "./draft.ts";
import { starterSql, suggestedDatasetName, type StarterColumn } from "./starterSql.ts";

/** How many result rows the step shows (enough to see the shape). */
const SHOWN_ROWS = 8;

export type QueryChoice =
  | { kind: "existing"; datasetId: number }
  | { kind: "new"; connectionId: number; sql: string; name: string; starter: StarterColumn[] | null; starterSql: string | null };

type Props = {
  draft: SetupDraft;
  onChange(patch: Partial<SetupDraft>): void;
  diagram: SchemaDiagram | null;
  /** Add a chart: the project's datasets ("Use a dataset") and connections ("Write new SQL"). */
  datasets?: DatasetListItem[];
  connections?: Connection[];
  connectionName: string;
  dbType: "postgresql" | "mysql";
  /** What Continue should do, or null while it can't (nothing run yet). */
  onReady(choice: QueryChoice | null): void;
};

/** Step 3: write (or keep) a query, run it, name the dataset it becomes. In "Add a chart",
 * an existing dataset can be picked instead. */
export default function QueryStep({ draft, onChange, diagram, datasets, connections, connectionName, dbType, onReady }: Props) {
  const adding = datasets !== undefined;
  const [from, setFrom] = useState<"existing" | "new">(adding && datasets.length ? "existing" : "new");
  const [datasetId, setDatasetId] = useState<number | null>(datasets?.[0]?.id ?? null);
  const [connectionId, setConnectionId] = useState<number | null>(draft.connectionId ?? connections?.[0]?.id ?? null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<QueryErrorDetail | null>(null);
  const [running, setRunning] = useState(false);

  const starter = useMemo(
    () => (diagram && draft.table ? starterSql(diagram, draft.table, draft.marks, dbType) : null),
    [diagram, draft.table, draft.marks, dbType],
  );
  const sql = draft.sql ?? starter?.sql ?? "SELECT\n  *\nFROM ";
  const name = draft.datasetName || (draft.table ? suggestedDatasetName(draft.table, (starter?.sql.includes("JOIN") ?? false)) : "My dataset");

  function report(next: { result?: QueryResult | null; from?: "existing" | "new"; datasetId?: number | null; connectionId?: number | null; name?: string; sql?: string }) {
    const r = next.result === undefined ? result : next.result;
    const f = next.from ?? from;
    const id = next.datasetId === undefined ? datasetId : next.datasetId;
    const conn = next.connectionId === undefined ? connectionId : next.connectionId;
    if (f === "existing") return onReady(id !== null ? { kind: "existing", datasetId: id } : null);
    const text = next.sql ?? sql;
    onReady(
      r && conn !== null
        ? { kind: "new", connectionId: conn, sql: text, name: (next.name ?? name).trim(), starter: starter?.columns ?? null, starterSql: starter?.sql ?? null }
        : null,
    );
  }

  // Picking an existing dataset is ready right away (the first one is preselected).
  useEffect(() => {
    report({});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the initial choice
  }, []);

  async function run() {
    if (connectionId === null) return;
    setRunning(true);
    setError(null);
    try {
      const r = await runQuery(connectionId, sql, 100);
      setResult(r);
      report({ result: r });
    } catch (err) {
      setResult(null);
      setError(toQueryError(err));
      report({ result: null });
    } finally {
      setRunning(false);
    }
  }

  const picker = adding && datasets.length > 0 && (
    <div className="start" role="group" aria-label="Start from">
      {(["existing", "new"] as const).map((k) => (
        <button
          key={k}
          type="button"
          className={`pill small${from === k ? " primary" : " ghost"}`}
          aria-pressed={from === k}
          onClick={() => {
            setFrom(k);
            report({ from: k });
          }}
        >
          {k === "existing" ? "Use a dataset" : "Write new SQL"}
        </button>
      ))}
    </div>
  );

  if (adding && from === "existing") {
    return (
      <>
        {picker}
        <label className="field setup-narrow">
          <span>Dataset</span>
          <select
            value={datasetId ?? ""}
            onChange={(e) => {
              setDatasetId(Number(e.target.value));
              report({ datasetId: Number(e.target.value) });
            }}
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </>
    );
  }

  const shownConnection = connections?.find((c) => c.id === connectionId)?.name ?? connectionName;
  return (
    <>
      {picker}
      {adding && connections && connections.length > 1 && (
        <label className="field setup-narrow">
          <span>Database</span>
          <select
            value={connectionId ?? ""}
            onChange={(e) => {
              setConnectionId(Number(e.target.value));
              setResult(null);
              report({ connectionId: Number(e.target.value), result: null });
            }}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="setup-editor">
        <div className="setup-editor-bar">
          <span>SQL · {shownConnection}</span>
          <button type="button" className="primary pill small" onClick={() => void run()} disabled={running || connectionId === null}>
            {running ? "Running…" : "Run ▸"}
          </button>
        </div>
        <label htmlFor="setup-sql" className="sr-only">
          SQL query
        </label>
        <textarea
          id="setup-sql"
          spellCheck={false}
          value={sql}
          onChange={(e) => {
            onChange({ sql: e.target.value });
            setResult(null);
            report({ result: null, sql: e.target.value });
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
        />
      </div>
      {error && <QueryErrorAlert error={error} className="mt-4" />}
      {result && (
        <>
          <div className="setup-results">
            <div className="setup-results-meta" role="status">
              <span>
                <b aria-hidden>●</b> Done
              </span>
              <span>
                {result.row_count.toLocaleString("en-US")}
                {result.truncated ? "+" : ""} rows
              </span>
              <span>{result.duration_ms} ms</span>
              <span>read-only</span>
            </div>
            <div className="setup-results-scroll">
              <table>
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.name} className={c.type === "number" ? "n" : undefined}>
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, SHOWN_ROWS).map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j} className={result.columns[j]?.type === "number" ? "n" : undefined}>
                          {cellText(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <label className="field save-dataset">
            <span>Save this as a dataset</span>
            <input
              value={name}
              maxLength={200}
              onChange={(e) => {
                onChange({ datasetName: e.target.value });
                report({ name: e.target.value });
              }}
            />
          </label>
        </>
      )}
    </>
  );
}
