/** Query engine, query history and saved queries: /api/query, /api/query-history, /api/saved-queries (types mirror backend/app/schemas). */

import { inProject, json, request, withProject } from "./http.ts";


// ---------- query engine ----------

export type GenericType = "number" | "string" | "datetime" | "date" | "boolean" | "other";

export type QueryResult = {
  columns: { name: string; type: GenericType; db_type: string }[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  duration_ms: number;
};

/** Body of `detail` when a query fails (400): POST /api/query, chart data, dataset preview,
 * metric validation. `title` / `hint` are plain language (null: not recognized, show
 * `message`); `raw` is the database's own error (shown under "Details"). */
export type QueryErrorDetail = {
  kind: string;
  message: string;
  line: number | null;
  column: number | null;
  title?: string | null;
  hint?: string | null;
  raw?: string | null;
};

export function isQueryErrorDetail(value: unknown): value is QueryErrorDetail {
  return typeof value === "object" && value !== null && "kind" in value && "message" in value;
}

/** Throws ApiError; for failed queries `detail` is a QueryErrorDetail. Abort with `signal`. */
export const runQuery = (connectionId: number, sql: string, limit?: number, signal?: AbortSignal) =>
  request<QueryResult>("/api/query", {
    method: "POST",
    body: json({ connection_id: connectionId, sql, limit: limit ?? null }),
    signal,
  });

// ---------- query history ----------

export type QueryHistoryItem = {
  id: number;
  connection_id: number | null;
  connection_name: string | null;
  sql: string;
  status: "success" | "error";
  row_count: number | null;
  duration_ms: number;
  error_message: string | null;
  started_at: string;
};

export type QueryHistoryPage = {
  items: QueryHistoryItem[];
  total: number;
  limit: number;
  offset: number;
};

export function listQueryHistory(params: { connectionId?: number; limit?: number; offset?: number }) {
  const search = new URLSearchParams();
  if (params.connectionId !== undefined) search.set("connection_id", String(params.connectionId));
  search.set("limit", String(params.limit ?? 50));
  search.set("offset", String(params.offset ?? 0));
  return request<QueryHistoryPage>(`/api/query-history?${search.toString()}`);
}

// ---------- saved queries ----------

export type SavedQuery = {
  id: number;
  /** The project it belongs to (null: the built-in Uploads connection). */
  project_id?: number | null;
  name: string;
  description: string | null;
  connection_id: number | null;
  connection_name: string | null;
  sql: string;
  created_at: string;
  updated_at: string;
};

export type SavedQueryInput = {
  name: string;
  description: string | null;
  connection_id: number | null;
  sql: string;
};

export function listSavedQueries(q?: string) {
  const search = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return request<SavedQuery[]>(withProject(`/api/saved-queries${search}`));
}

export const getSavedQuery = (id: number) => request<SavedQuery>(`/api/saved-queries/${id}`);

export const createSavedQuery = (input: SavedQueryInput) =>
  request<SavedQuery>("/api/saved-queries", { method: "POST", body: json(inProject(input)) });

export const updateSavedQuery = (id: number, input: SavedQueryInput) =>
  request<SavedQuery>(`/api/saved-queries/${id}`, { method: "PUT", body: json(input) });

export const deleteSavedQuery = (id: number) =>
  request<void>(`/api/saved-queries/${id}`, { method: "DELETE" });
