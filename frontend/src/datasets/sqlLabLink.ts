import type { Dataset } from "../api.ts";

/** Router state that asks SQL Lab to open a new tab (see SqlLabPage). */
export type OpenTabRequest = {
  title: string;
  sql: string;
  connectionId: number;
  schema: string | null;
};

export type SqlLabLocationState = { openTab: OpenTabRequest };

export function isSqlLabLocationState(value: unknown): value is SqlLabLocationState {
  if (typeof value !== "object" || value === null || !("openTab" in value)) return false;
  const tab = (value).openTab;
  return (
    typeof tab === "object" &&
    tab !== null &&
    typeof (tab as OpenTabRequest).sql === "string" &&
    typeof (tab as OpenTabRequest).connectionId === "number"
  );
}

/** State for navigate("/sql-lab", { state }) that opens the dataset's SQL in a new tab. */
export function openDatasetInSqlLab(dataset: Dataset): SqlLabLocationState {
  return {
    openTab: {
      title: dataset.name,
      sql: dataset.sqllab_sql,
      connectionId: dataset.connection_id,
      schema: dataset.kind === "table" ? dataset.schema : null,
    },
  };
}
