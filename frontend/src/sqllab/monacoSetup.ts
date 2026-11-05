/**
 * Monaco is bundled locally (no CDN): only the editor core + SQL highlighting.
 * One global SQL completion provider reads the active tab's connection/schema
 * from `setCompletionContext` and uses the schema cache, so typing never
 * triggers more than one request per table.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { ColumnInfo, DbType } from "../api.ts";
import {
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  extractTableRefs,
  qualifiedName,
  qualifierBeforeCursor,
  quoteIdent,
  resolveQualifier,
  type TableRef,
} from "./completion.ts";
import { getColumns, getSchemas, getTables, peekAllTables } from "./schemaCache.ts";

export type CompletionContext = {
  connectionId: number | null;
  schema: string | null;
  dbType: DbType;
};

let context: CompletionContext = { connectionId: null, schema: null, dbType: "postgresql" };

export function setCompletionContext(next: CompletionContext): void {
  context = next;
}

let initialized = false;

export function setupMonaco(): void {
  if (initialized) return;
  initialized = true;
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
  loader.config({ monaco });
  monaco.languages.registerCompletionItemProvider("sql", completionProvider);
}

const MAX_REFERENCED_TABLES = 8;

/** Only fetch columns for tables that really exist (avoids requests for half-typed names). */
async function existingTable(
  connectionId: number,
  schema: string,
  table: string,
): Promise<string | null> {
  const tables = await getTables(connectionId, schema);
  const match = tables.find((t) => t.name === table) ?? tables.find((t) => t.name.toLowerCase() === table.toLowerCase());
  return match?.name ?? null;
}

async function columnsOf(
  connectionId: number,
  ref: Pick<TableRef, "schema" | "table">,
  defaultSchema: string | null,
): Promise<{ table: string; columns: ColumnInfo[] } | null> {
  const schema = ref.schema ?? defaultSchema;
  if (!schema) return null;
  const table = await existingTable(connectionId, schema, ref.table);
  if (!table) return null;
  return { table, columns: await getColumns(connectionId, schema, table) };
}

const completionProvider: monaco.languages.CompletionItemProvider = {
  triggerCharacters: ["."],

  async provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range: monaco.IRange = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
    const before = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: word.startColumn,
    });
    const { connectionId, schema, dbType } = context;
    const Kind = monaco.languages.CompletionItemKind;
    const suggestions: monaco.languages.CompletionItem[] = [];
    const add = (
      label: string,
      kind: monaco.languages.CompletionItemKind,
      detail: string,
      insertText = label,
      sortText = "5",
    ) => suggestions.push({ label, kind, detail, insertText, range, sortText: sortText + label });

    const qualifier = qualifierBeforeCursor(before);

    try {
      if (connectionId !== null) {
        const refs = extractTableRefs(model.getValue());
        const schemas = await getSchemas(connectionId);

        if (qualifier) {
          const target = resolveQualifier(qualifier, refs, schemas);
          if (target?.kind === "columns") {
            const found = await columnsOf(connectionId, target, schema);
            for (const c of found?.columns ?? []) {
              add(c.name, Kind.Field, `${c.type}${c.primary_key ? " · PK" : ""}`, quoteIdent(c.name, dbType), "1");
            }
          } else if (target?.kind === "tables") {
            for (const t of await getTables(connectionId, target.schema)) {
              add(t.name, t.type === "view" ? Kind.Interface : Kind.Struct, t.type, quoteIdent(t.name, dbType), "1");
            }
          }
          return { suggestions };
        }

        // Columns of the tables used in this query come first.
        const referenced = await Promise.allSettled(
          refs.slice(0, MAX_REFERENCED_TABLES).map((r) => columnsOf(connectionId, r, schema)),
        );
        const seen = new Set<string>();
        for (const item of referenced) {
          if (item.status !== "fulfilled" || !item.value) continue;
          for (const c of item.value.columns) {
            if (seen.has(c.name)) continue;
            seen.add(c.name);
            add(c.name, Kind.Field, `${item.value.table} · ${c.type}`, quoteIdent(c.name, dbType), "1");
          }
        }

        if (schema) {
          for (const t of await getTables(connectionId, schema)) {
            add(t.name, t.type === "view" ? Kind.Interface : Kind.Struct, `${t.type} in ${schema}`, quoteIdent(t.name, dbType), "2");
          }
        }
        for (const [otherSchema, tables] of peekAllTables(connectionId)) {
          if (otherSchema === schema) continue;
          for (const t of tables) {
            const name = qualifiedName(otherSchema, t.name, dbType);
            add(name, Kind.Struct, t.type, name, "3");
          }
        }
        for (const s of schemas) add(s, Kind.Module, "schema", quoteIdent(s, dbType), "3");
      }
    } catch {
      // Metadata couldn't be loaded (connection down?): keywords still work.
    }

    if (!qualifier) {
      for (const k of SQL_KEYWORDS) add(k, Kind.Keyword, "keyword", k, "4");
      for (const f of SQL_FUNCTIONS) add(f, Kind.Function, "function", f, "4");
    }
    return { suggestions };
  },
};
