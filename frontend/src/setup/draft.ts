/** The setup wizard's state, kept on the project as a draft (PUT /api/projects/:id/setup-draft)
 * so an unfinished setup can be resumed. Choices and SQL only: never a password. */
import type { Marks } from "./starterSql.ts";

export type SetupStep = "source" | "explore" | "query" | "chart";

export const STEP_LABELS: Record<SetupStep, string> = {
  source: "Connect data",
  explore: "Explore",
  query: "Query",
  chart: "Chart",
};

/** A new project: 4 steps. "Add a chart" on a dashboard: query, then chart. */
export const PROJECT_STEPS: SetupStep[] = ["source", "explore", "query", "chart"];
export const ADD_CHART_STEPS: SetupStep[] = ["query", "chart"];

export type SetupDraft = {
  step: SetupStep;
  source: "db" | "file" | null;
  /** The connection the data is on (a database, or the built-in Uploads one for a file). */
  connectionId: number | null;
  /** A file: the dataset its upload became. */
  uploadDatasetId: number | null;
  schema: string | null;
  table: string | null;
  marks: Marks;
  /** null: the starter query (rebuilt from the table and marks). */
  sql: string | null;
  datasetName: string;
  /** The dataset made in the Query step, and the SQL it was made from (reused when unchanged). */
  datasetId: number | null;
  datasetSql: string | null;
};

export const EMPTY_DRAFT: SetupDraft = {
  step: "source",
  source: null,
  connectionId: null,
  uploadDatasetId: null,
  schema: null,
  table: null,
  marks: {},
  sql: null,
  datasetName: "",
  datasetId: null,
  datasetSql: null,
};

/** A stored draft, made safe to use (missing fields get their defaults). */
export function readDraft(value: unknown): SetupDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const draft = { ...EMPTY_DRAFT, ...(value as Partial<SetupDraft>) };
  if (!PROJECT_STEPS.includes(draft.step)) draft.step = "source";
  // The chart step lives in the chart editor: resume on the query that leads to it.
  if (draft.step === "chart") draft.step = "query";
  return draft;
}
