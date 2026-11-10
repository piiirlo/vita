import { useMemo, useState } from "react";
import type { ChartDataResult, Dataset } from "../api.ts";
import { categoryLabel, formatNumber, toNumber } from "./format.ts";
import { metricFormatter } from "./display.ts";
import { metricName, outputLabel, type ChartState } from "./model.ts";

type Sort = { index: number; desc: boolean } | null;

function compare(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1; // empty last
  if (b === null || b === undefined) return -1;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return String(a).localeCompare(String(b));
}

/** Table chart: labels as headers, formatted metrics, click a header to sort. */
export default function TableChart({
  state,
  result,
  dataset,
}: {
  state: ChartState;
  result: ChartDataResult;
  dataset: Dataset | null;
}) {
  const [sort, setSort] = useState<Sort>(null);
  const { query, display } = state;
  const grain = query.time?.grain ?? null;

  // Dataset value labels per column ("1" -> "Lethbridge").
  const valueLabels = useMemo(() => {
    const map: Record<string, Record<string, string>> = {};
    for (const c of dataset?.columns ?? []) if (c.value_labels) map[c.name] = c.value_labels;
    return map;
  }, [dataset]);

  const columns = useMemo(
    () =>
      result.columns.map((c) => {
        const metric = query.metrics.find((m) => metricName(m) === c.name);
        const formatMetric = metric ? metricFormatter(display, metric, dataset) : null;
        const isTime = Boolean(grain && c.name === query.time?.column);
        return {
          name: c.name,
          label: outputLabel(c.name, query, dataset),
          numeric: Boolean(metric) || c.type === "number",
          format: (value: unknown) =>
            formatMetric
              ? formatMetric(value)
              : isTime
                ? categoryLabel(value, grain)
                : value === null || value === undefined
                  ? "(empty)"
                  : (valueLabels[c.name]?.[String(value)] ?? (c.type === "number" ? formatNumber(value) : String(value))),
        };
      }),
    [result.columns, query, display, dataset, grain, valueLabels],
  );

  const rows = useMemo(() => {
    if (!sort) return result.rows;
    const sorted = [...result.rows].sort((a, b) => compare(a[sort.index], b[sort.index]));
    return sort.desc ? sorted.reverse() : sorted;
  }, [result.rows, sort]);

  function toggle(index: number) {
    setSort((s) => (s?.index !== index ? { index, desc: false } : s.desc ? null : { index, desc: true }));
  }

  return (
    <div className="chart-table-wrap">
      <table className="data-table chart-table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.name}
                className={c.numeric ? "num" : undefined}
                aria-sort={sort?.index === i ? (sort.desc ? "descending" : "ascending") : "none"}
              >
                <button className="th-sort" onClick={() => toggle(i)}>
                  {c.label}
                  {sort?.index === i && <span aria-hidden>{sort.desc ? " ▼" : " ▲"}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {columns.map((c, i) => (
                <td key={c.name} className={`${c.numeric ? "num" : ""}${row[i] === null ? " muted" : ""}`}>
                  {c.format(row[i])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
