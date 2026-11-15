/** The setup wizard's Explore and Query steps (pure): which columns are dates and which ones
 * to group by, the relations between tables, and a starter query that joins the picked table
 * with its neighbors along the foreign keys. */
import type { DbType, DiagramColumn, DiagramForeignKey, SchemaDiagram } from "../api.ts";
import { quoteIdentifier } from "../lib/sqlIdent.ts";

/** "table.column" → what the user marked. */
export type Mark = { time: boolean; group: boolean };
export type Marks = Record<string, Mark>;

export const markKey = (table: string, column: string) => `${table}.${column}`;

const DATE_TYPE = /date|time/i;
const NOT_DATE = /interval/i;
const TEXT_TYPE = /char|text|string|enum|citext|bool/i;
const NUMBER_TYPE = /int|numeric|decimal|float|double|real|money|number/i;

export const isDateType = (type: string) => DATE_TYPE.test(type) && !NOT_DATE.test(type);
export const isTextType = (type: string) => TEXT_TYPE.test(type);
export const isNumberType = (type: string) => NUMBER_TYPE.test(type);

/** Keys (ids) are neither breakdowns nor measures. */
const isKey = (c: DiagramColumn) => c.primary_key || c.foreign_key || /(^|_)id$/i.test(c.name);

/** What a column is marked by default: dates are time columns, text is a breakdown. */
export function defaultMark(column: DiagramColumn): Mark {
  return { time: isDateType(column.type), group: isTextType(column.type) && !isKey(column) };
}

/** The user's mark, else the default. */
export function markOf(marks: Marks, table: string, column: DiagramColumn): Mark {
  return marks[markKey(table, column.name)] ?? defaultMark(column);
}

/** "order_items → orders via order_id" for every foreign key touching `table` (all when null). */
export function relations(diagram: SchemaDiagram, table: string | null = null): string[] {
  return diagram.foreign_keys
    .filter((fk) => fk.referred_schema === diagram.schema_name && (table === null || fk.table === table || fk.referred_table === table))
    .map((fk) => `${fk.table} → ${fk.referred_table} via ${fk.columns.join(", ")}`);
}

type Join = { table: string; alias: string; fk: DiagramForeignKey; from: string };

/** Short, unique aliases: orders → o, order_items → oi. */
function aliasFor(table: string, taken: Set<string>): string {
  const base = table.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w[0]!.toLowerCase()).join("") || "t";
  let alias = base;
  for (let n = 2; taken.has(alias); n++) alias = `${base}${n}`;
  taken.add(alias);
  return alias;
}

export const MAX_JOINED_TABLES = 4;
export const MAX_COLUMNS = 12;

/** The picked table and its neighbors along foreign keys (either direction), nearest first:
 * at most MAX_JOINED_TABLES tables, two steps away at most. */
export function joinPlan(diagram: SchemaDiagram, table: string): { base: string; alias: string; joins: Join[]; aliases: Map<string, string> } {
  const taken = new Set<string>();
  const aliases = new Map([[table, aliasFor(table, taken)]]);
  const joins: Join[] = [];
  let frontier = [table];
  const local = diagram.foreign_keys.filter((fk) => fk.referred_schema === diagram.schema_name && fk.table !== fk.referred_table);
  for (let depth = 0; depth < 2 && aliases.size < MAX_JOINED_TABLES; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const fk of local) {
        const other = fk.table === current ? fk.referred_table : fk.referred_table === current ? fk.table : null;
        if (other === null || aliases.has(other) || aliases.size >= MAX_JOINED_TABLES) continue;
        if (!diagram.tables.some((t) => t.name === other)) continue;
        aliases.set(other, aliasFor(other, taken));
        joins.push({ table: other, alias: aliases.get(other)!, fk, from: current });
        next.push(other);
      }
    }
    frontier = next;
  }
  return { base: table, alias: aliases.get(table)!, joins, aliases };
}

/** One output column of the starter query and where it comes from. */
export type StarterColumn = { output: string; table: string; column: string; mark: Mark };

/** A starter query: the picked table joined with its neighbors; its time and breakdown columns
 * and number columns that aren't keys. `schema` null: tables without a schema prefix. */
export function starterSql(
  diagram: SchemaDiagram,
  table: string,
  marks: Marks,
  dbType: DbType,
): { sql: string; columns: StarterColumn[] } {
  const q = (name: string) => quoteIdentifier(name, dbType);
  const plan = joinPlan(diagram, table);
  const tables = [plan.base, ...plan.joins.map((j) => j.table)];
  const columns: StarterColumn[] = [];
  const used = new Set<string>();
  // Time columns first, then breakdowns, then numbers; the picked table first in each.
  const picks: { table: string; column: DiagramColumn; mark: Mark; rank: number }[] = [];
  tables.forEach((name, order) => {
    const t = diagram.tables.find((x) => x.name === name);
    for (const column of t?.columns ?? []) {
      const mark = markOf(marks, name, column);
      const rank = mark.time ? 0 : mark.group ? 1 : isNumberType(column.type) && !isKey(column) ? 2 : -1;
      if (rank >= 0) picks.push({ table: name, column, mark, rank: rank * 100 + order });
    }
  });
  picks.sort((a, b) => a.rank - b.rank);
  for (const pick of picks.slice(0, MAX_COLUMNS)) {
    const output = used.has(pick.column.name.toLowerCase()) ? `${pick.table}_${pick.column.name}` : pick.column.name;
    used.add(output.toLowerCase());
    columns.push({ output, table: pick.table, column: pick.column.name, mark: pick.mark });
  }

  const from = (name: string) => `${q(diagram.schema_name)}.${q(name)}`;
  const select = columns.length
    ? columns
        .map((c) => {
          const ref = `${plan.aliases.get(c.table)}.${q(c.column)}`;
          return c.output === c.column ? ref : `${ref} AS ${q(c.output)}`;
        })
        .join(",\n       ")
    : `${plan.alias}.*`;
  const lines = [`SELECT ${select}`, `FROM ${from(plan.base)} ${plan.alias}`];
  for (const join of plan.joins) {
    const { fk } = join;
    // fk.table.columns -> fk.referred_table.referred_columns, whichever side is new.
    const left = plan.aliases.get(fk.table)!;
    const right = plan.aliases.get(fk.referred_table)!;
    const on = fk.columns.map((col, i) => `${left}.${q(col)} = ${right}.${q(fk.referred_columns[i] ?? col)}`).join(" AND ");
    lines.push(`JOIN ${from(join.table)} ${join.alias} ON ${on}`);
  }
  return { sql: lines.join("\n"), columns };
}

/** The marks for a dataset's columns (by name): from the starter query's columns when the SQL
 * kept them, else from a marked column of the same name. */
export function marksForDataset(names: string[], starter: StarterColumn[], marks: Marks): Map<string, Mark> {
  const out = new Map<string, Mark>();
  for (const name of names) {
    const fromStarter = starter.find((c) => c.output.toLowerCase() === name.toLowerCase());
    if (fromStarter) {
      out.set(name, fromStarter.mark);
      continue;
    }
    const same = Object.entries(marks).find(([key]) => key.split(".").pop()!.toLowerCase() === name.toLowerCase());
    if (same) out.set(name, same[1]);
  }
  return out;
}

/** The marks for a new dataset's columns (by name), as a function of the names. */
export function marksFor(draft: { marks: Marks }, starter: StarterColumn[] | null) {
  return (names: string[]) => marksForDataset(names, starter ?? [], draft.marks);
}

/** A dataset name from the picked table: "orders" → "Order lines" when joined, else "Orders". */
export function suggestedDatasetName(table: string, joined: boolean): string {
  const words = table.replace(/[_-]+/g, " ").trim();
  const singular = words.replace(/s$/i, "");
  const name = joined ? `${singular} lines` : words;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
