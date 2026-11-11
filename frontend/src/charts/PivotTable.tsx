import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { ChartDataResult, Dataset } from "../api.ts";
import type { Coverage } from "./display.ts";
import { PIVOT_MAX_COLUMNS, type ChartState } from "./model.ts";
import { PIVOT_MAX_ROWS_SHOWN, pivotLayout } from "./pivotTable.ts";

const toggle = (set: ReadonlySet<string>, key: string) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

/** Rows x columns with SQL-computed totals. Groups collapse (rows, and outer columns when
 * there are two column dimensions); that only changes the view, never the query. */
/** An incomplete period: dashed underline + italic (not color alone), and said for screen readers. */
function Incomplete({ on }: { on?: boolean }) {
  return on ? <span className="sr-only"> (incomplete period)</span> : null;
}

export default function PivotTable({
  state,
  result,
  dataset,
  coverageFor,
}: {
  state: ChartState;
  result: ChartDataResult;
  dataset: Dataset | null;
  coverageFor?: (ref: string) => Coverage | null;
}) {
  const { query, display } = state;
  const [collapsedRows, setCollapsedRows] = useState<ReadonlySet<string>>(new Set());
  const [collapsedCols, setCollapsedCols] = useState<ReadonlySet<string>>(new Set());
  const totals = Boolean(query.totals);
  const layout = useMemo(
    () =>
      pivotLayout(result, {
        rows: query.dimensions,
        cols: query.column_dimensions ?? [],
        metrics: query.metrics,
        totals,
        display,
        dataset,
        collapsedRows,
        collapsedCols,
        coverageFor,
      }),
    [result, query.dimensions, query.column_dimensions, query.metrics, totals, display, dataset, collapsedRows, collapsedCols, coverageFor],
  );
  const canCollapseRows = totals && query.dimensions.length > 1;

  return (
    <div className="pivot">
      {(layout.hiddenColumns > 0 || layout.hiddenRows > 0 || result.truncated) && (
        <p className="chart-notice" role="note">
          <TriangleAlert size={14} aria-hidden />
          <span>
            {layout.hiddenColumns > 0 &&
              `Showing the first ${PIVOT_MAX_COLUMNS} of ${layout.totalColumns} columns: move a dimension to the rows or add a filter. `}
            {layout.hiddenRows > 0 && `Showing the first ${PIVOT_MAX_ROWS_SHOWN} rows: collapse groups or add a filter. `}
            {result.truncated && "The row limit was reached, so some cells or totals are missing: raise it in the Data tab."}
          </span>
        </p>
      )}
      <div className="pivot-scroll">
        <table className="pivot-table">
          <thead>
            {layout.header.map((row, ri) => (
              <tr key={ri}>
                {row.map((h, hi) => (
                  <th
                    key={hi}
                    colSpan={h.colSpan}
                    rowSpan={h.rowSpan}
                    scope={h.kind === "corner" ? undefined : "col"}
                    className={`pivot-h pivot-h-${h.kind}${h.incomplete ? " pivot-incomplete" : ""}`}
                    title={h.incomplete ? "Incomplete period" : undefined}
                  >
                    {h.groupKey ? (
                      <button
                        type="button"
                        className="pivot-toggle"
                        aria-expanded={!h.collapsed}
                        aria-label={`${h.collapsed ? "Expand" : "Collapse"} ${h.label}`}
                        onClick={() => setCollapsedCols((s) => toggle(s, h.groupKey!))}
                      >
                        {h.collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                        {h.label}
                        <Incomplete on={h.incomplete} />
                      </button>
                    ) : (
                      <>
                        {h.label}
                        <Incomplete on={h.incomplete} />
                      </>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {layout.body.map((row) => (
              <tr key={`${row.kind}:${row.depth}:${row.key}`} className={`pivot-row-${row.kind}`}>
                <th
                  scope="row"
                  className={`pivot-label${row.incomplete ? " pivot-incomplete" : ""}`}
                  title={row.incomplete ? "Incomplete period" : undefined}
                  style={{ paddingLeft: 12 + row.depth * 16 }}
                >
                  {row.kind === "group" && canCollapseRows ? (
                    <button
                      type="button"
                      className="pivot-toggle"
                      aria-expanded={!row.collapsed}
                      aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${row.label}`}
                      onClick={() => setCollapsedRows((s) => toggle(s, row.key))}
                    >
                      {row.collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                      {row.label}
                      <Incomplete on={row.incomplete} />
                    </button>
                  ) : (
                    <>
                      {row.label}
                      <Incomplete on={row.incomplete} />
                    </>
                  )}
                </th>
                {row.cells.map((c, ci) => (
                  <td key={ci} className={`num pivot-cell-${layout.columns[ci]?.kind ?? "leaf"}${c.heat ? ` heat-${c.heat}` : ""}`}>
                    {c.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {layout.hasIncomplete && (
        <p className="pivot-footnote">
          <span className="pivot-incomplete" aria-hidden>
            Dashed
          </span>{" "}
          = incomplete period (the time range or the data covers only part of it)
        </p>
      )}
    </div>
  );
}
