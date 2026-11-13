import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import type { QueryErrorDetail } from "../api.ts";
import { cn } from "../lib/cn.ts";
import { queryErrorDetails, queryErrorSummary } from "./queryError.ts";
import { ErrorAlert } from "./ui/alert.tsx";

/** The body of a query error: plain language, a hint, and the raw error under "Details". */
export function QueryErrorBody({ error }: { error: QueryErrorDetail }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const details = queryErrorDetails(error);
  return (
    <>
      <span className="query-error-title">{queryErrorSummary(error)}</span>
      {error.hint && <div className="mt-1 text-muted">{error.hint}</div>}
      {details && (
        <div className="mt-1.5">
          <button
            type="button"
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 rounded-[6px] border-0 bg-transparent p-0",
              "font-mono text-[11px] uppercase tracking-[.14em] text-muted hover:text-text",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
            )}
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronRight
              size={13}
              aria-hidden
              className={cn("transition-transform duration-150 ease-out", open && "rotate-90")}
            />
            Details
          </button>
          {open && (
            <pre
              id={id}
              className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-xs text-text"
            >
              {details}
            </pre>
          )}
        </div>
      )}
    </>
  );
}

/** A failed query (SQL Lab, charts, dataset preview, metric validation): the danger color,
 * an icon and the word "Error", then plain language + hint + "Details" (the raw error). */
export function QueryErrorAlert({ error, className }: { error: QueryErrorDetail; className?: string }) {
  return (
    <ErrorAlert className={className}>
      <QueryErrorBody error={error} />
    </ErrorAlert>
  );
}
