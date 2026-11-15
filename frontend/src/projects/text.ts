import type { ProjectSource } from "../api.ts";

/** "1 dashboard", "3 dashboards" ("query" → "queries"). */
export function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${word.endsWith("y") && !/[aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;
}

/** Where a project's data comes from, as the folder says it. */
export function sourceLabel(sources: ProjectSource[]): string {
  if (sources.length === 0) return "No data yet";
  return sources.map((s) => (s === "database" ? "Database" : "File")).join(" · ");
}
