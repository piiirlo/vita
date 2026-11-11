import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { ChartDataResult, Dataset } from "../api.ts";
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
export default function PivotTable({ state, result, dataset }: { state: ChartState; result: ChartDataResult; dataset: Dataset | null }) {
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
      }),
    [result, query.dimensions, query.column_dimensions, query.metrics, totals, display, dataset, collapsedRows, collapsedCols],
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
                    className={`pivot-h pivot-h-${h.kind}`}
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
                      </button>
                    ) : (
                      h.label
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {layout.body.map((row) => (
              <tr key={`${row.kind}:${row.depth}:${row.key}`} className={`pivot-row-${row.kind}`}>
                <th scope="row" className="pivot-label" style={{ paddingLeft: 12 + row.depth * 16 }}>
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
                    </button>
                  ) : (
                    row.label
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
    </div>
  );
}
