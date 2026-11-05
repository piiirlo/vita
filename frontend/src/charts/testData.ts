/** Shared test fixture: a dataset like the "order lines" SQL dataset. */
import type { Dataset, DatasetColumn } from "../api.ts";

function col(name: string, type: DatasetColumn["generic_type"], extra: Partial<DatasetColumn> = {}): DatasetColumn {
  return {
    id: name.length,
    name,
    position: 0,
    label: null,
    raw_type: type,
    generic_type: type,
    generic_type_override: null,
    effective_type: type,
    is_temporal: type === "date",
    is_dimension: type === "string",
    is_hidden: false,
    is_missing: false,
    description: null,
    ...extra,
  };
}

export const DATASET: Dataset = {
  id: 4,
  name: "order lines",
  description: null,
  connection_id: 2,
  connection_name: "sampledb",
  kind: "sql",
  schema: null,
  table_name: null,
  column_count: 4,
  metric_count: 2,
  created_at: "2026-11-05T10:00:00Z",
  updated_at: "2026-11-05T10:00:00Z",
  db_type: "postgresql",
  sql: "SELECT 1",
  main_time_column: "order_date",
  columns: [
    col("order_date", "date"),
    col("status", "string", { label: "Status" }),
    col("channel", "string", { label: "Channel" }),
    col("line_total", "number"),
  ],
  metrics: [
    { id: 1, name: "count", label: "Count", expression: "COUNT(*)", description: null, number_format: null, is_builtin: true },
    { id: 2, name: "revenue", label: "Revenue", expression: "SUM(line_total)", description: null, number_format: "$0,0.00", is_builtin: false },
  ],
  warnings: [],
  sqllab_sql: "SELECT 1",
};
