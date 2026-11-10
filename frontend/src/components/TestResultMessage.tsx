import type { TestResult } from "../api.ts";
import { cn } from "../lib/cn.ts";
import { ErrorAlert } from "./ui/alert.tsx";

/** The result of "Test connection": a clear green "Connected" (check in a circle, with a short
 * entrance) or the error. `compact` is the smaller version used in the connections list. */
export default function TestResultMessage({ result, compact = false }: { result: TestResult; compact?: boolean }) {
  if (!result.ok) {
    return (
      <ErrorAlert className={compact ? "mt-1.5 px-2.5 py-1.5 text-[13px]" : "mb-3.5"}>
        {result.error ?? "Connection failed."}
      </ErrorAlert>
    );
  }
  return (
    <div
      role="status"
      data-testid="test-ok"
      className={cn(
        "test-ok inline-flex items-center gap-2.5 rounded-control border border-success-border bg-success-bg text-text",
        compact ? "mt-1.5 px-2.5 py-1 text-[13px]" : "mb-3.5 px-3.5 py-2.5 text-sm",
      )}
    >
      <svg
        className="test-ok-icon shrink-0"
        width={compact ? 18 : 24}
        height={compact ? 18 : 24}
        viewBox="0 0 24 24"
        aria-hidden
      >
        <circle cx="12" cy="12" r="12" className="test-ok-circle" />
        <path d="M7 12.5l3.2 3.2L17 9" className="test-ok-check" pathLength={1} />
      </svg>
      <strong className="font-semibold text-success">Connected</strong>
    </div>
  );
}
