/** The Query step's "Save this as a dataset": make (or reuse) the dataset, then mark its time
 * and breakdown columns the way the Explore step said. */
import { createDataset, getDataset, updateDataset, type ColumnSettings, type Dataset } from "../api.ts";
import type { Mark } from "./starterSql.ts";

/** Column settings for the marks: time only for columns that are dates (or already time),
 * so a text column never fails the save. The first time column becomes the main one. */
export function markedSettings(dataset: Dataset, marks: Map<string, Mark>): { columns: ColumnSettings[]; mainTime: string | null } {
  const columns: ColumnSettings[] = [];
  const timeNames: string[] = [];
  const unmarked = new Set<string>();
  for (const c of dataset.columns) {
    const mark = marks.get(c.name);
    if (!mark || c.is_missing) continue;
    const type = c.generic_type_override ?? c.generic_type;
    const time = mark.time && (type === "date" || type === "datetime" || c.is_temporal);
    columns.push({
      id: c.id,
      label: c.label,
      generic_type_override: c.generic_type_override,
      is_temporal: time,
      is_dimension: mark.group,
      is_hidden: c.is_hidden,
      description: c.description,
    });
    if (time) timeNames.push(c.name);
    else unmarked.add(c.name);
  }
  const current = dataset.main_time_column;
  const mainTime = current && !unmarked.has(current) ? current : (timeNames[0] ?? null);
  return { columns, mainTime };
}

export async function applyMarks(dataset: Dataset, marks: Map<string, Mark>, name = dataset.name): Promise<Dataset> {
  const { columns, mainTime } = markedSettings(dataset, marks);
  if (!columns.length && name === dataset.name) return dataset;
  return updateDataset(dataset.id, { name, description: dataset.description, main_time_column: mainTime, columns });
}

/** A new SQL dataset on the connection, marked. */
export async function createQueryDataset(
  name: string,
  connectionId: number,
  sql: string,
  marksFor: (columnNames: string[]) => Map<string, Mark>,
): Promise<Dataset> {
  const created = await createDataset({ name, description: null, connection_id: connectionId, kind: "sql", sql });
  return applyMarks(created, marksFor(created.columns.map((c) => c.name)));
}

/** The uploaded file's own dataset, renamed and marked (when its query was left as it was). */
export async function reuseUploadDataset(datasetId: number, name: string, marksFor: (columnNames: string[]) => Map<string, Mark>): Promise<Dataset> {
  const dataset = await getDataset(datasetId);
  return applyMarks(dataset, marksFor(dataset.columns.map((c) => c.name)), name);
}
