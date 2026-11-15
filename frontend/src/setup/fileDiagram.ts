import { getDataset, type SchemaDiagram } from "../api.ts";
import { markKey, type Marks } from "./starterSql.ts";

/** A file's dataset as a one-table diagram (its columns already know their types and marks). */
export async function fileDiagram(datasetId: number): Promise<{ diagram: SchemaDiagram; marks: Marks }> {
  const d = await getDataset(datasetId);
  const table = d.table_name ?? d.name;
  const columns = d.columns.filter((c) => !c.is_missing);
  const marks: Marks = {};
  for (const c of columns) marks[markKey(table, c.name)] = { time: c.is_temporal, group: c.is_dimension };
  return {
    diagram: {
      schema_name: d.schema ?? "uploads",
      tables: [
        {
          name: table,
          type: "table",
          columns: columns.map((c) => ({ name: c.name, type: c.generic_type_override ?? c.generic_type, nullable: true, primary_key: false, foreign_key: false })),
        },
      ],
      foreign_keys: [],
      truncated: false,
    },
    marks,
  };
}
