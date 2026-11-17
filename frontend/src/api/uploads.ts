/** File uploads: /api/uploads (types mirror backend/app/schemas). */

import { ApiError, errorMessage, json, request, UNAUTHORIZED_EVENT, withProject } from "./http.ts";


// ---------- file uploads (CSV / TSV / Excel -> a table in the Uploads database -> a dataset) ----------

export type UploadColumnType = "text" | "integer" | "decimal" | "date" | "datetime" | "boolean";
export type DateOrder = "ymd" | "dmy" | "mdy";
export type UploadEncoding = "utf-8" | "utf-8-sig" | "windows-1252" | "iso-8859-1";
export type UploadMode = "create" | "replace" | "append";

export type UploadEvent = { mode: UploadMode; file_name: string; rows: number; uploaded_at: string; uploaded_by: string | null };

/** Where an uploaded dataset's data came from (newest first). */
export type UploadSource = {
  file_name: string;
  uploaded_at: string;
  uploaded_by: string | null;
  /** The last create / replace plus the appends after it. */
  row_count: number;
  history: UploadEvent[];
};

export type UploadDelimiter = "," | ";" | "	" | "|";

export type UploadColumnOption = { index: number; name: string; type: UploadColumnType; ignore: boolean; date_order: DateOrder | null };

export type UploadReadOptions = {
  encoding: UploadEncoding;
  delimiter: UploadDelimiter;
  header: boolean;
  skip_rows: number;
  decimal: "." | ",";
  thousands: "" | "," | "." | " " | "'";
  /** null: guess the columns again (after the delimiter / header / encoding changed). */
  columns: UploadColumnOption[] | null;
  /** Excel: the sheet to read (null: the first). */
  sheet?: string | null;
};

export type UploadColumnPreview = {
  index: number;
  source_name: string;
  name: string;
  type: UploadColumnType;
  guessed_type: UploadColumnType;
  ignore: boolean;
  date_order: DateOrder | null;
  date_ambiguous: boolean;
  checked: number;
  misfits: number;
  examples: { row: number; value: string }[];
  /** Replace / append: matched to the table's column (its name and type are kept). */
  locked: boolean;
  /** Replace / append: matched, "new" (replace adds it), "extra" (append has no place for it). */
  status: "matched" | "new" | "extra" | null;
  /** Values like "N/A" / "null" that become empty (non-text columns). */
  null_words?: number;
  /** Whole numbers all between 1900 and 2100: "name" = the name says year too (a time column),
   * "values" = only the values (suggested later in the Columns tab). */
  years?: "name" | "values" | null;
};

export type UploadProblemKind =
  | "misfit"
  | "garbled"
  | "one_column"
  | "ambiguous_date"
  | "ragged"
  | "too_many_columns"
  | "no_columns"
  | "no_rows"
  | "columns_mismatch";
export type UploadProblem = { kind: UploadProblemKind; message: string; column: number | null; examples: string[]; blocking: boolean };

export type UploadPreview = {
  upload_id: number;
  file_name: string;
  file_size: number;
  file_kind: "csv" | "xlsx";
  /** Excel: the workbook's sheets. */
  sheets: string[];
  mode: UploadMode;
  /** Replace / append: the dataset the file is for. */
  target: { id: number; name: string; table_name: string } | null;
  /** Replace / append: the table's columns the file has no column for. */
  missing_columns: string[];
  dataset_name: string;
  options: UploadReadOptions;
  detected: UploadReadOptions;
  columns: UploadColumnPreview[];
  rows: (string | null)[][];
  bad_cells: [number, number][];
  problems: UploadProblem[];
  sampled_rows: number;
  more_rows: boolean;
};

export type UploadJob = {
  id: number;
  file_name: string;
  file_size: number;
  status: "pending" | "importing" | "done" | "failed" | "cancelled" | "expired";
  mode: UploadMode;
  progress: number;
  rows_done: number;
  row_count: number | null;
  table_name: string | null;
  dataset_id: number | null;
  error: string | null;
  /** kind "misfit": didn't fit the type; "null_word": "N/A", "null"... read as empty. */
  bad_values: { column: string; count: number; examples: { row: number; value: string }[]; kind?: "misfit" | "null_word" }[];
  created_at: string;
  finished_at: string | null;
};

/** Send a file (the raw body; XHR for upload progress). Resolves with the preview. With
 * `target`, the file replaces or is appended to that uploaded dataset's data. */
export function uploadFile(
  file: File,
  onProgress?: (share: number) => void,
  signal?: AbortSignal,
  target?: { datasetId: number; mode: "replace" | "append" },
): Promise<UploadPreview> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", target ? `/api/uploads?dataset_id=${target.datasetId}&mode=${target.mode}` : withProject("/api/uploads"));
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON (a proxy error page)
      }
      if (xhr.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadPreview);
      else {
        const detail = typeof body === "object" && body !== null && "detail" in body ? body.detail : undefined;
        reject(new ApiError(xhr.status, errorMessage(body, xhr.status), detail));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "The upload failed: the server couldn't be reached."));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    xhr.send(file);
  });
}

export const previewUpload = (id: number, options: UploadReadOptions) =>
  request<UploadPreview>(`/api/uploads/${id}/preview`, { method: "POST", body: json(options) });

export const importUpload = (id: number, body: { options: UploadReadOptions; dataset_name: string; on_error: "null" | "stop" }) =>
  request<UploadJob>(`/api/uploads/${id}/import`, { method: "POST", body: json(body) });

export const getUpload = (id: number) => request<UploadJob>(`/api/uploads/${id}`);

export const cancelUpload = (id: number) => request<void>(`/api/uploads/${id}`, { method: "DELETE" });
