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
  /** "uploads": the built-in Uploads connection (managed by Vita: no edit / delete). */
  builtin?: string | null;
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
    const detail = (body).detail;
    if (typeof detail === "string") return detail;
    // Query errors: {kind, message, line, column}
    if (typeof detail === "object" && detail !== null && "message" in detail) {
      return String((detail).message);
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

/** Fired when the API answers 401 (not logged in, or the session expired). */
export const UNAUTHORIZED_EVENT = "vita:unauthorized";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "detail" in body
      ? (body).detail
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

export type DiagramColumn = { name: string; type: string; nullable: boolean; primary_key: boolean; foreign_key: boolean };
export type DiagramTable = { name: string; type: "table" | "view"; columns: DiagramColumn[] };
export type DiagramForeignKey = {
  name: string | null;
  table: string;
  columns: string[];
  referred_schema: string;
  referred_table: string;
  referred_columns: string[];
};
export type SchemaDiagram = { schema_name: string; tables: DiagramTable[]; foreign_keys: DiagramForeignKey[]; truncated: boolean };

/** Tables, columns and foreign keys of one schema (the Browse page's diagram). */
export const getSchemaDiagram = (id: number, schema: string, signal?: AbortSignal) =>
  request<SchemaDiagram>(`/api/connections/${id}/schemas/${seg(schema)}/diagram`, { signal });

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
  return request<DatasetListItem[]>(`/api/datasets${query ? `?${query}` : ""}`);
}

export const getDataset = (id: number) => request<Dataset>(`/api/datasets/${id}`);

export const dismissDatasetNote = (datasetId: number, noteId: string) =>
  request<void>(`/api/datasets/${datasetId}/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });

/** Throws ApiError; when the SQL or table fails, `detail` is a QueryErrorDetail. */
export const createDataset = (input: DatasetCreateInput) =>
  request<Dataset>("/api/datasets", { method: "POST", body: json(input) });

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

// ---------- charts ----------

export type VizType =
  | "table"
  | "big_number"
  | "bar"
  | "line"
  | "pie"
  | "area"
  | "combo"
  | "treemap"
  | "funnel"
  | "gauge"
  | "pivot_table"
  | "heatmap"
  | "scatter"
  | "histogram"
  | "world_map";
export type Aggregate = "SUM" | "AVG" | "MIN" | "MAX" | "COUNT" | "COUNT_DISTINCT";
export type Grain = "day" | "week" | "month" | "quarter" | "year";
/** A chart's time axis: a grain's buckets, or "raw" = every time value as it is. */
export type AxisGrain = Grain | "raw";
export type RangeKind =
  | "none"
  | "last_7_days"
  | "last_30_days"
  | "last_90_days"
  | "last_12_months"
  | "this_year"
  | "last_year"
  | "custom";
export type FilterOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "IN"
  | "NOT IN"
  | "BETWEEN"
  | "IS NULL"
  | "IS NOT NULL"
  | "LIKE";

export type AdhocMetric = { column: string; aggregate: Aggregate; label?: string | null };
/** Custom SQL written in the chart editor, e.g. SUM(amount) / NULLIF(SUM(quantity), 0): the
 * same checks as a saved metric's expression. Its label is its output name. */
export type SqlMetric = { sql: string; label: string; number_format?: string | null };
/** A saved metric of the dataset (by name), an ad-hoc one, or custom SQL. */
export type MetricRef = string | AdhocMetric | SqlMetric;

export const isSqlMetric = (ref: MetricRef): ref is SqlMetric => typeof ref !== "string" && "sql" in ref;
export const isAdhocMetric = (ref: MetricRef): ref is AdhocMetric => typeof ref !== "string" && "column" in ref;
export type FilterScalar = string | number | boolean | null;

export type ChartFilter = {
  column: string;
  operator: FilterOperator;
  value: FilterScalar | FilterScalar[];
};

export type ChartQuery = {
  dataset_id: number;
  metrics: MetricRef[];
  /** Grouping dimensions (treemap: its levels, outer first; pivot table: the rows). */
  dimensions: string[];
  /** Pivot table: the dimensions across. */
  column_dimensions?: string[];
  /** Pivot table: subtotals and totals, computed in SQL (rows carry __row_level / __col_level). */
  totals?: boolean;
  series: string | null;
  /** Histogram: the number column, cut into `count` bins between its min and max, or bins of
   * `width` (aligned to multiples of it). Rows come back as __bin / __bin_start / __bin_end. */
  bins?: { column: string; count?: number | null; width?: number | null } | null;
  /** Table "raw records" mode. */
  columns: string[];
  time: {
    column: string | null;
    grain: AxisGrain | null;
    range: { kind: RangeKind; start?: string | null; end?: string | null };
  } | null;
  filters: ChartFilter[];
  order_by: { by: string; descending: boolean } | null;
  row_limit: number;
  series_limit: number | null;
};

/** range_start / range_end: the time range the query filtered on (days, both inclusive; null = open
 * on that side or no range). */
export type ChartDataResult = QueryResult & {
  sql: string;
  range_start?: string | null;
  range_end?: string | null;
  /** Set when the result came from the chart-data cache: when it was computed. */
  cached_at?: string | null;
};

/** Chart-data cache options: lifetime in seconds (0 = off, null = default 10 min), refresh = skip it. */
export type CacheOptions = { cacheTtl?: number | null; refresh?: boolean };

/** Where a dataset has data: MIN / MAX of a time column (ISO strings; null when it has none). */
export type TimeExtent = { column: string; min: string | null; max: string | null };

export type ChartParams = { query: ChartQuery; display: Record<string, unknown> };

export type SavedChart = {
  id: number;
  name: string;
  description: string | null;
  dataset_id: number;
  dataset_name: string;
  viz_type: VizType;
  params: ChartParams;
  created_at: string;
  updated_at: string;
  /** The dashboards showing this chart (one chart's responses; empty in lists). */
  dashboards?: { id: number; name: string }[];
};

export type ChartInput = {
  name: string;
  description: string | null;
  viz_type: VizType;
  params: ChartParams;
};

/** Throws ApiError; invalid queries and failed queries have a QueryErrorDetail `detail`. */
export const fetchChartData = (vizType: VizType, query: ChartQuery, signal?: AbortSignal, cache: CacheOptions = {}) =>
  request<ChartDataResult>("/api/chart-data", {
    method: "POST",
    body: json({
      viz_type: vizType,
      query,
      ...(cache.cacheTtl === undefined || cache.cacheTtl === null ? {} : { cache_ttl: cache.cacheTtl }),
      ...(cache.refresh ? { refresh: true } : {}),
    }),
    signal,
  });

export function listCharts(q?: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const query = params.toString();
  return request<SavedChart[]>(`/api/charts${query ? `?${query}` : ""}`);
}

export const getChart = (id: number) => request<SavedChart>(`/api/charts/${id}`);

export const createChart = (input: ChartInput) =>
  request<SavedChart>("/api/charts", { method: "POST", body: json(input) });

export const updateChart = (id: number, input: ChartInput) =>
  request<SavedChart>(`/api/charts/${id}`, { method: "PUT", body: json(input) });

export const deleteChart = (id: number) => request<void>(`/api/charts/${id}`, { method: "DELETE" });

// ---------- dashboards ----------

export type RefreshInterval = "off" | "1m" | "5m" | "15m" | "1h";

type TilePosition = { id: string; x: number; y: number; w: number; h: number };
export type ChartTileSpec = TilePosition & { type: "chart"; chart_id: number };
export type TextTileSpec = TilePosition & { type: "text"; text: string };
export type DashboardTile = ChartTileSpec | TextTileSpec;

export type DashboardChartInfo = { id: number; name: string; viz_type: VizType };

export type DashboardListItem = {
  id: number;
  name: string;
  description: string | null;
  chart_count: number;
  created_at: string;
  updated_at: string;
};

export type Dashboard = Omit<DashboardListItem, "chart_count"> & {
  layout: DashboardTile[];
  refresh_interval: RefreshInterval;
  /** Cache lifetime for every tile (seconds, 0 = off); null = each chart's own. */
  cache_ttl: number | null;
  /** Basic info of the charts in the layout, keyed by chart id. */
  charts: Record<string, DashboardChartInfo>;
};

export type DashboardInput = {
  name: string;
  description: string | null;
  layout: DashboardTile[];
  refresh_interval: RefreshInterval;
  cache_ttl?: number | null;
};

export function listDashboards(q?: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const query = params.toString();
  return request<DashboardListItem[]>(`/api/dashboards${query ? `?${query}` : ""}`);
}

export const getDashboard = (id: number) => request<Dashboard>(`/api/dashboards/${id}`);

export const createDashboard = (input: DashboardInput) =>
  request<Dashboard>("/api/dashboards", { method: "POST", body: json(input) });

export const updateDashboard = (id: number, input: DashboardInput) =>
  request<Dashboard>(`/api/dashboards/${id}`, { method: "PUT", body: json(input) });

export const deleteDashboard = (id: number) =>
  request<void>(`/api/dashboards/${id}`, { method: "DELETE" });

export const duplicateDashboard = (id: number) =>
  request<Dashboard>(`/api/dashboards/${id}/duplicate`, { method: "POST" });

/** Adds a chart tile below the existing tiles. */
export const addChartToDashboard = (id: number, chartId: number) =>
  request<Dashboard>(`/api/dashboards/${id}/charts`, { method: "POST", body: json({ chart_id: chartId }) });

// ---------- auth ----------

export type CurrentUser = { username: string };

/** Throws ApiError: 401 wrong credentials, 429 too many failed attempts. */
export const login = (username: string, password: string) =>
  request<CurrentUser>("/api/auth/login", { method: "POST", body: json({ username, password }) });

export const logout = () => request<void>("/api/auth/logout", { method: "POST" });

/** The logged-in user; throws ApiError 401 when not logged in. */
export const fetchCurrentUser = () => request<CurrentUser>("/api/auth/me");

export const changePassword = (currentPassword: string, newPassword: string) =>
  request<void>("/api/auth/password", {
    method: "POST",
    body: json({ current_password: currentPassword, new_password: newPassword }),
  });

// ---------- file uploads (CSV / TSV / Excel -> a table in the Uploads database -> a dataset) ----------

export type UploadColumnType = "text" | "integer" | "decimal" | "date" | "datetime" | "boolean";
export type DateOrder = "ymd" | "dmy" | "mdy";
export type UploadEncoding = "utf-8" | "utf-8-sig" | "windows-1252" | "iso-8859-1";
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
    xhr.open("POST", target ? `/api/uploads?dataset_id=${target.datasetId}&mode=${target.mode}` : "/api/uploads");
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
