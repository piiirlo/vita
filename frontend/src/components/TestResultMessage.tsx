import type { TestResult } from "../api.ts";

export default function TestResultMessage({
  result,
  compact = false,
}: {
  result: TestResult;
  compact?: boolean;
}) {
  const className = `alert ${result.ok ? "alert-ok" : "alert-error"}${compact ? " compact" : ""}`;
  return (
    <p className={className} role="status">
      {result.ok ? "Connection successful." : (result.error ?? "Connection failed.")}
    </p>
  );
}
