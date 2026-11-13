/** Query errors (SQL Lab, charts, dataset preview, metric validation) for the UI. */
import { ApiError, isQueryErrorDetail, type QueryErrorDetail } from "../api.ts";

/** Any thrown error as a QueryErrorDetail (API query errors keep their title / hint / raw). */
export function toQueryError(err: unknown): QueryErrorDetail {
  if (err instanceof ApiError && isQueryErrorDetail(err.detail)) return err.detail;
  return { kind: "other", message: err instanceof Error ? err.message : String(err), line: null, column: null };
}

/** The one-line summary of a query error: its plain-language title, else the message. */
export function queryErrorSummary(error: QueryErrorDetail): string {
  return error.title ?? error.message;
}

/** What "Details" shows: the database's own words (or the full message when they add
 * something to the title). Null when there is nothing more to see. */
export function queryErrorDetails(error: QueryErrorDetail): string | null {
  const details = error.raw ?? (error.title ? error.message : null);
  if (!details || details === queryErrorSummary(error)) return null;
  return details;
}
