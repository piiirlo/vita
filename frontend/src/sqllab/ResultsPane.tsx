import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { QueryErrorDetail, QueryResult } from "../api.ts";
import { QueryErrorBody } from "../components/QueryErrorAlert.tsx";
import { toNumber } from "../charts/format.ts";
import {
  cellText,
  csvFilename,
  downloadCsv,
  formatDuration,
  nextSort,
  sortRows,
  toCsv,
  type SortState,
} from "./results.ts";

export type RunState =
  | { status: "running"; startedAt: number; previous: QueryResult | null }
  | { status: "done"; result: QueryResult }
  | { status: "error"; error: QueryErrorDetail }
  | { status: "stopped" };

type Props = {
  run: RunState | undefined;
  title: string;
  onStop(): void;
};

const ROW_HEIGHT = 28;
const ROW_NUMBER_WIDTH = 56;

/** Column width from the header and the first rows' content. */
function columnWidth(name: string, type: string, rows: unknown[][], index: number): number {
  // Header: "NAME type" side by side in spaced-out mono (about 9px per character).
  const header = (name.length + type.length + 1) * 9 + 36;
  let chars = 0;
  for (let i = 0; i < Math.min(rows.length, 200); i += 1) {
    chars = Math.max(chars, cellText(rows[i]?.[index]).length);
  }
  return Math.min(Math.max(header, chars * 8 + 32, 90), 440);
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts.
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

export default function ResultsPane({ run, title, onStop }: Props) {
  const startedAt = run?.status === "running" ? run.startedAt : null;
  const elapsed = useElapsed(startedAt);
  const result =
    run?.status === "done" ? run.result : run?.status === "running" ? run.previous : null;

  return (
    <div className="results-pane">
      <div className="status-bar">
        {run === undefined && <span className="muted">Run a query with Ctrl+Enter.</span>}
        {run?.status === "running" && (
          <>
            <span className="run-state running">
              <span className="live-dot" aria-hidden />
              Running…
            </span>
            <span>{formatDuration(elapsed)}</span>
            <span className="spacer" />
            <button className="small danger" onClick={onStop}>
              Stop
            </button>
            <span className="scan-line" aria-hidden />
          </>
        )}
        {run?.status === "stopped" && (
          <span className="text-warning">
            Stopped. The database may keep working on it until its 30-second timeout.
          </span>
        )}
        {run?.status === "error" && (
          <div className="run-error" role="alert">
            <span className="run-state error">Error</span>
            <div className="run-error-message">
              <QueryErrorBody error={run.error} />
            </div>
          </div>
        )}
        {run?.status === "done" && <ResultSummary result={run.result} />}
      </div>
      {result && <ResultsGrid key={resultKey(result)} result={result} title={title} />}
    </div>
  );
}

// Remount the grid (reset sort / selection / scroll) for every new result.
const resultIds = new WeakMap<QueryResult, number>();
let nextResultId = 0;
function resultKey(result: QueryResult): number {
  let id = resultIds.get(result);
  if (id === undefined) {
    nextResultId += 1;
    id = nextResultId;
    resultIds.set(result, id);
  }
  return id;
}

function ResultSummary({ result }: { result: QueryResult }) {
  const rows = result.row_count.toLocaleString();
  return (
    <>
      <span className="run-state done">
        <span className="dot dot-ok" aria-hidden />
        Done
      </span>
      <span>
        <strong>{rows}</strong> {result.row_count === 1 ? "row" : "rows"}
      </span>
      <span className="muted">{formatDuration(result.duration_ms)}</span>
      <span className="muted">read-only</span>
      {result.truncated && (
        <span className="truncated" role="status">
          Showing the first {rows} rows. More exist: raise the row limit or add filters.
        </span>
      )}
    </>
  );
}

function ResultsGrid({ result, title }: { result: QueryResult; title: string }) {
  const [sort, setSort] = useState<SortState>(null);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const types = useMemo(() => result.columns.map((c) => c.type), [result]);
  const rows = useMemo(() => sortRows(result.rows, sort, types), [result, sort, types]);
  const widths = useMemo(
    () => result.columns.map((c, i) => columnWidth(c.name, c.db_type || c.type, result.rows, i)),
    [result],
  );
  // Numeric cells get a thin "share" bar (value / column max), like the mockup.
  const maxima = useMemo(
    () =>
      result.columns.map((c, i) => {
        if (c.type !== "number") return 0;
        let max = 0;
        for (const r of result.rows) max = Math.max(max, Math.abs(toNumber(r[i]) ?? 0));
        return max;
      }),
    [result],
  );
  // Columns grow to fill the pane (minmax with 1fr) but never get narrower than their content.
  const gridTemplate = `${ROW_NUMBER_WIDTH}px ${widths.map((w) => `minmax(${w}px, 1fr)`).join(" ")}`;
  const totalWidth = ROW_NUMBER_WIDTH + widths.reduce((a, b) => a + b, 0);

  const columns = useMemo<ColumnDef<unknown[]>[]>(
    () =>
      result.columns.map((c, i) => ({
        id: String(i),
        header: c.name,
        accessorFn: (row) => row[i],
      })),
    [result],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true, // sortRows() keeps NULLs last in both directions
  });
  const tableRows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
    // Lets the first rows render before the container is measured (and in tests).
    initialRect: { width: 1000, height: 600 },
  });

  const selectedValue = selected ? rows[selected.row]?.[selected.col] : undefined;

  async function copySelected() {
    if (!selected) return;
    await copyText(cellText(selectedValue));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  function onKeyDown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selected) {
      event.preventDefault();
      void copySelected();
    }
  }

  function exportCsv() {
    downloadCsv(
      csvFilename(title),
      toCsv(
        result.columns.map((c) => c.name),
        rows,
      ),
    );
  }

  return (
    <>
      <div className="grid-toolbar">
        <span className="muted small">
          {selected
            ? `${result.columns[selected.col]?.name ?? ""} · row ${selected.row + 1}: ${cellText(selectedValue).slice(0, 80)}`
            : "Click a cell to select it, Ctrl+C to copy."}
        </span>
        {selected && (
          <button className="small" onClick={() => void copySelected()}>
            {copied ? "Copied" : "Copy value"}
          </button>
        )}
        <span className="spacer" />
        <button className="small" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>

      <div
        className="grid-scroll"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        role="grid"
        aria-rowcount={rows.length}
      >
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          <div className="grid-header" style={{ gridTemplateColumns: gridTemplate }} role="row">
            <div className="grid-cell grid-rownum">#</div>
            {table.getHeaderGroups()[0]?.headers.map((header, i) => {
              const col = result.columns[i];
              if (!col) return null;
              const arrow = sort?.column === i ? (sort.desc ? " ▼" : " ▲") : "";
              return (
                <div
                  key={header.id}
                  className="grid-cell grid-head"
                  role="columnheader"
                  title={`${col.name}: ${col.db_type} (click to sort)`}
                  onClick={() => setSort((s) => nextSort(s, i))}
                >
                  <span className="grid-head-name">
                    {col.name}
                    {arrow}
                  </span>
                  <span className="grid-head-type">{col.db_type || col.type}</span>
                </div>
              );
            })}
          </div>

          {rows.length === 0 && <p className="muted pad">The query returned no rows.</p>}

          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = tableRows[item.index];
              if (!row) return null;
              return (
                <div
                  key={row.id}
                  className={`grid-row${item.index % 2 ? " odd" : ""}`}
                  role="row"
                  style={{
                    gridTemplateColumns: gridTemplate,
                    height: ROW_HEIGHT,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <div className="grid-cell grid-rownum">{item.index + 1}</div>
                  {row.getVisibleCells().map((cell, colIndex) => {
                    const value = cell.getValue();
                    const isNull = value === null || value === undefined;
                    const isSelected = selected?.row === item.index && selected.col === colIndex;
                    const type = result.columns[colIndex]?.type;
                    const className = [
                      "grid-cell",
                      isNull ? "null" : "",
                      type === "number" ? "num" : "",
                      isSelected ? "selected" : "",
                    ].join(" ");
                    const text = cellText(value);
                    const max = maxima[colIndex] ?? 0;
                    const share = max > 0 && !isNull ? Math.abs(toNumber(value) ?? 0) / max : 0;
                    return (
                      <div
                        key={cell.id}
                        className={className}
                        role="gridcell"
                        title={text.length > 30 ? text.slice(0, 2000) : undefined}
                        onClick={() => setSelected({ row: item.index, col: colIndex })}
                      >
                        {text}
                        {share > 0 && <span className="share-bar" style={{ width: `calc((100% - 12px) * ${share})` }} aria-hidden />}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
