/** Datasets and their metrics: /api/datasets (types mirror backend/app/schemas). */

import type { TimeExtent } from "./charts.ts";
import type { DbType } from "./connections.ts";
import { inProject, json, request, withProject } from "./http.ts";
import type { GenericType, QueryErrorDetail, QueryResult } from "./queries.ts";
import type { DateOrder, UploadSource } from "./uploads.ts";


// ---------- datasets ----------

export type DatasetKind = "table" | "sql";

export type DatasetColumn = {
  id: number;
  name: string;
  position: number;
  label: string | null;
  raw_type: string;
  /** What the database reports (refreshed on sync). */
  generic_type: GenericType;
  generic_type_override: GenericType | null;
  effective_type: GenericType;
  is_temporal: boolean;
  /** How a time column becomes a date: null (a date / datetime), a year number (2006),
   * text dates read in `text_date_format`, or "pending" (not checked yet). */
  time_kind?: TimeKind | null;
  text_date_format?: DateOrder | null;
  /** An identifier (row_id, postal_code...): not offered for SUM / AVG. */
  is_identifier?: boolean;
  /** Whole numbers between 1900 and 2100: the Columns tab suggests "use as time". */
  looks_like_years?: boolean;
  is_dimension: boolean;
  is_hidden: boolean;
  /** The last sync didn't find this column. */
  is_missing: boolean;
  description: string | null;
  /** Display labels for values ("1" -> "Lethbridge"); keys are the values as text. */
  value_labels?: Record<string, string> | null;
};

export type TimeKind = "year_number" | "text_date" | "pending";

export type ColumnSettings = Pick<
  DatasetColumn,
  "id" | "label" | "generic_type_override" | "is_temporal" | "is_dimension" | "is_hidden" | "description"
> & {
  /** Left out: unchanged. {} clears them. */
  value_labels?: Record<string, string>;
  /** A text column marked temporal: the order of its dates (null: guess, or keep). */
  text_date_format?: DateOrder | null;
  /** Left out: unchanged. */
  is_identifier?: boolean;
};

/** Something Vita changed on its own (e.g. a column unmarked as time), shown on the dataset page. */
export type DatasetNote = { id: string; message: string; created_at: string };

export type DatasetMetric = {
  id: number;
  name: string;
  label: string | null;
  expression: string;
  description: string | null;
  number_format: string | null;
  is_builtin: boolean;
};

export type MetricInput = {
  name: string;
  label: string | null;
  expression: string;
  description: string | null;
  number_format: string | null;
};

export type DatasetListItem = {
  id: number;
  /** The project it belongs to (null: the built-in Uploads connection). */
  project_id?: number | null;
  name: string;
  description: string | null;
  connection_id: number;
  connection_name: string;
  kind: DatasetKind;
  schema: string | null;
  table_name: string | null;
  column_count: number;
  metric_count: number;
  created_at: string;
  updated_at: string;
  /** A table dataset on an uploaded file's table (Replace / Append file; delete its table). */
  is_upload: boolean;
};

export type Dataset = DatasetListItem & {
  upload_source: UploadSource | null;
  db_type: DbType;
  sql: string | null;
  main_time_column: string | null;
  columns: DatasetColumn[];
  metrics: DatasetMetric[];
  warnings: string[];
  sqllab_sql: string;
  notes?: DatasetNote[];
};

export type DatasetCreateInput =
  | { name: string; description: string | null; connection_id: number; kind: "table"; schema: string; table_name: string }
  | { name: string; description: string | null; connection_id: number; kind: "sql"; sql: string };

export type DatasetUpdateInput = {
  name: string;
  description: string | null;
  sql?: string;
  main_time_column: string | null;
  columns?: ColumnSettings[];
  /** Only columns marked is_missing can be removed. */
  delete_column_ids?: number[];
};

export type SyncResponse = {
  dataset: Dataset;
  summary: { added: string[]; removed: string[]; restored: string[]; type_changed: string[] };
};

export type PreviewResponse = QueryResult & { sql: string };

export type MetricValidation = {
  ok: boolean;
  error: QueryErrorDetail | null;
  warning: string | null;
  value: unknown;
};

export function listDatasets(q?: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const query = params.toString();
  return request<DatasetListItem[]>(withProject(`/api/datasets${query ? `?${query}` : ""}`));
}

export const getDataset = (id: number) => request<Dataset>(`/api/datasets/${id}`);

export const dismissDatasetNote = (datasetId: number, noteId: string) =>
  request<void>(`/api/datasets/${datasetId}/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });

/** Throws ApiError; when the SQL or table fails, `detail` is a QueryErrorDetail. */
export const createDataset = (input: DatasetCreateInput) =>
  request<Dataset>("/api/datasets", { method: "POST", body: json(inProject(input)) });

export const updateDataset = (id: number, input: DatasetUpdateInput) =>
  request<Dataset>(`/api/datasets/${id}`, { method: "PUT", body: json(input) });

/** `dropTable`: a dataset made from an uploaded file also drops its table (409 while other
 * datasets read it). */
export const deleteDataset = (id: number, dropTable = false) =>
  request<void>(`/api/datasets/${id}${dropTable ? "?drop_table=true" : ""}`, { method: "DELETE" });

export const syncDataset = (id: number) =>
  request<SyncResponse>(`/api/datasets/${id}/sync`, { method: "POST" });

export const previewDataset = (id: number, signal?: AbortSignal) =>
  request<PreviewResponse>(`/api/datasets/${id}/preview`, { signal });

/** MIN / MAX of a time column (default: the main time column). One cheap aggregate query. */
export function getTimeExtent(id: number, column?: string | null, signal?: AbortSignal) {
  const qs = column ? `?${new URLSearchParams({ column })}` : "";
  return request<TimeExtent>(`/api/datasets/${id}/time-extent${qs}`, { signal });
}

export const createMetric = (datasetId: number, input: MetricInput) =>
  request<DatasetMetric>(`/api/datasets/${datasetId}/metrics`, { method: "POST", body: json(input) });

export const updateMetric = (datasetId: number, metricId: number, input: MetricInput) =>
  request<DatasetMetric>(`/api/datasets/${datasetId}/metrics/${metricId}`, {
    method: "PUT",
    body: json(input),
  });

export const deleteMetric = (datasetId: number, metricId: number) =>
  request<void>(`/api/datasets/${datasetId}/metrics/${metricId}`, { method: "DELETE" });

export const validateMetric = (datasetId: number, expression: string) =>
  request<MetricValidation>(`/api/datasets/${datasetId}/metrics/validate`, {
    method: "POST",
    body: json({ expression }),
  });
