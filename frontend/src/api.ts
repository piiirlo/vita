// ---------- types (mirror backend/app/schemas) ----------

export type HealthResponse = {
  status: "ok";
  database: "ok" | "error";
  detail: string | null;
};

export type DbType = "postgresql" | "mysql";

export const DEFAULT_PORTS: Record<DbType, number> = { postgresql: 5432, mysql: 3306 };

export type ExtraOptions = Record<string, unknown>;

/** A saved connection as returned by the API. Never contains the password. */
export type Connection = {
  id: number;
  name: string;
  db_type: DbType;
  host: string;
  port: number;
  database: string;
  username: string;
  /** Whether a password is saved. The password itself is never returned. */
  has_password: boolean;
  extra: ExtraOptions | null;
  created_at: string;
  updated_at: string;
};

/**
 * Password rules (same for save and test):
 * - clear_password: true -> no password
 * - non-empty password   -> use this password
 * - empty password       -> keep the saved one (on create: no password)
 */
export type ConnectionFields = {
  db_type: DbType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  clear_password: boolean;
  extra: ExtraOptions | null;
};

/** Example "extra options" per database type; both are real driver arguments. */
export const EXTRA_OPTIONS_EXAMPLES: Record<DbType, string> = {
  postgresql: '{"sslmode": "require"}',
  mysql: '{"ssl_ca": "/path/to/ca.pem"}',
};

export type ConnectionInput = ConnectionFields & { name: string };

export type TestResult = { ok: boolean; error: string | null };

export type TableInfo = { name: string; type: "table" | "view" };

export type ColumnInfo = {
  name: string;
  type: string;
  nullable: boolean;
  primary_key: boolean;
};

// ---------- request helper ----------

export class ApiError extends Error {
  readonly status: number;
  /** Raw `detail` from the response body (an object for query errors). */
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** Pull a readable message out of a FastAPI error body. */
function errorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    // Query errors: {kind, message, line, column}
    if (typeof detail === "object" && detail !== null && "message" in detail) {
      return String((detail as { message: unknown }).message);
    }
    // 422 validation errors: [{loc: [...], msg: "..."}]
    if (Array.isArray(detail)) {
      return detail
        .map((d: { loc?: unknown[]; msg?: string }) => {
          const field = d.loc?.slice(1).join(".");
          return field ? `${field}: ${d.msg ?? "invalid"}` : (d.msg ?? "invalid");
        })
        .join("; ");
    }
  }
  return `Request failed (HTTP ${status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "detail" in body
      ? (body as { detail: unknown }).detail
      : undefined;
    throw new ApiError(response.status, errorMessage(body, response.status), detail);
  }
  return body as T;
}

const json = (data: unknown): string => JSON.stringify(data);
const seg = encodeURIComponent;

// ---------- health ----------

function isHealthResponse(value: unknown): value is HealthResponse {
  return typeof value === "object" && value !== null && "status" in value && "database" in value;
}

/**
 * Calls GET /api/health. The backend answers 503 (with a body) when the
 * database is down, so a 503 is still a valid health report.
 * Throws if the backend itself can't be reached.
 */
export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health");
  const body: unknown = await response.json().catch(() => null);
  if (!isHealthResponse(body)) {
    throw new Error(`Unexpected response from backend (HTTP ${response.status})`);
  }
  return body;
}

// ---------- connections ----------

export const listConnections = () => request<Connection[]>("/api/connections");

export const getConnection = (id: number) => request<Connection>(`/api/connections/${id}`);

export const createConnection = (input: ConnectionInput) =>
  request<Connection>("/api/connections", { method: "POST", body: json(input) });

/** An empty password keeps the saved one. */
export const updateConnection = (id: number, input: ConnectionInput) =>
  request<Connection>(`/api/connections/${id}`, { method: "PUT", body: json(input) });

export const deleteConnection = (id: number) =>
  request<void>(`/api/connections/${id}`, { method: "DELETE" });

/** Test details without saving. With `connectionId` and an empty password, the saved password is used. */
export const testConnectionDetails = (fields: ConnectionFields, connectionId?: number) =>
  request<TestResult>("/api/connections/test", {
    method: "POST",
    body: json({ ...fields, connection_id: connectionId ?? null }),
  });

export const testSavedConnection = (id: number) =>
  request<TestResult>(`/api/connections/${id}/test`, { method: "POST" });

export const listSchemas = (id: number) => request<string[]>(`/api/connections/${id}/schemas`);

export const listTables = (id: number, schema: string) =>
  request<TableInfo[]>(`/api/connections/${id}/schemas/${seg(schema)}/tables`);

// ---------- query engine ----------

export type GenericType = "number" | "string" | "datetime" | "date" | "boolean" | "other";

export type QueryResult = {
  columns: { name: string; type: GenericType; db_type: string }[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  duration_ms: number;
};

/** Throws ApiError; for failed queries `detail` is {kind, message, line, column}. */
/** Body of `detail` when POST /api/query answers 400. */
export type QueryErrorDetail = {
  kind: string;
  message: string;
  line: number | null;
  column: number | null;
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
  return request<SavedQuery[]>(`/api/saved-queries${search}`);
}

export const getSavedQuery = (id: number) => request<SavedQuery>(`/api/saved-queries/${id}`);

export const createSavedQuery = (input: SavedQueryInput) =>
  request<SavedQuery>("/api/saved-queries", { method: "POST", body: json(input) });

export const updateSavedQuery = (id: number, input: SavedQueryInput) =>
  request<SavedQuery>(`/api/saved-queries/${id}`, { method: "PUT", body: json(input) });

export const deleteSavedQuery = (id: number) =>
  request<void>(`/api/saved-queries/${id}`, { method: "DELETE" });

export const listColumns = (id: number, schema: string, table: string) =>
  request<ColumnInfo[]>(
    `/api/connections/${id}/schemas/${seg(schema)}/tables/${seg(table)}/columns`,
  );

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
  is_dimension: boolean;
  is_hidden: boolean;
  /** The last sync didn't find this column. */
  is_missing: boolean;
  description: string | null;
};

export type ColumnSettings = Pick<
  DatasetColumn,
  "id" | "label" | "generic_type_override" | "is_temporal" | "is_dimension" | "is_hidden" | "description"
>;

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
};

export type Dataset = DatasetListItem & {
  db_type: DbType;
  sql: string | null;
  main_time_column: string | null;
  columns: DatasetColumn[];
  metrics: DatasetMetric[];
  warnings: string[];
  sqllab_sql: string;
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
  return request<DatasetListItem[]>(`/api/datasets${query ? `?${query}` : ""}`);
}

export const getDataset = (id: number) => request<Dataset>(`/api/datasets/${id}`);

/** Throws ApiError; when the SQL or table fails, `detail` is a QueryErrorDetail. */
export const createDataset = (input: DatasetCreateInput) =>
  request<Dataset>("/api/datasets", { method: "POST", body: json(input) });

export const updateDataset = (id: number, input: DatasetUpdateInput) =>
  request<Dataset>(`/api/datasets/${id}`, { method: "PUT", body: json(input) });

export const deleteDataset = (id: number) =>
  request<void>(`/api/datasets/${id}`, { method: "DELETE" });

export const syncDataset = (id: number) =>
  request<SyncResponse>(`/api/datasets/${id}/sync`, { method: "POST" });

export const previewDataset = (id: number, signal?: AbortSignal) =>
  request<PreviewResponse>(`/api/datasets/${id}/preview`, { signal });

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
