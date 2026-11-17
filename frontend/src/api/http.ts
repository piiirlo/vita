/** Shared by every API area: request() (JSON, ApiError, the 401 event), errorText(), and the
 * current project that lists and creates are scoped to. Types mirror backend/app/schemas. */

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
export function errorMessage(body: unknown, status: number): string {
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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

export const json = (data: unknown): string => JSON.stringify(data);
export const seg = encodeURIComponent;

/** A caught error as text, for toasts and error messages. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- current project ----------

let currentProject: number | null = null;

/** The project the pages are in (ProjectProvider sets it from the URL; null outside one,
 * e.g. the old top-level pages). Lists then ask only for its items, and new items go in it. */
export function setCurrentProject(id: number | null) {
  currentProject = id;
}
export const getCurrentProject = () => currentProject;

/** Adds `project_id=` to a list URL when in a project. */
export function withProject(path: string): string {
  if (currentProject === null) return path;
  return `${path}${path.includes("?") ? "&" : "?"}project_id=${currentProject}`;
}

/** Adds `project_id` to a create payload when in a project. */
export function inProject<T extends object>(input: T): T & { project_id?: number } {
  return currentProject === null ? input : { ...input, project_id: currentProject };
}
