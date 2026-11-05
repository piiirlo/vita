/**
 * Monaco is bundled locally (no CDN): the editor core with its standard features
 * + SQL highlighting, but none of the big language services (TS/JSON/CSS/HTML).
 * One SQL completion provider reads the active tab's connection/schema from
 * `setCompletionContext` and uses the schema cache, so typing never triggers
 * more than one request per table.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
// IMPORTANT: `editor.api` alone is a bare editor. The suggest widget (autocomplete),
// hover tooltips, find, folding, comment toggling, etc. are "editor contributions"
// that only `edcore.main` (via `editor.all`) loads. Without this import, completion
// providers are registered but nothing ever asks them or shows their results.
import "monaco-editor/esm/vs/editor/edcore.main";
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

/** Language id of the SQL editor; the completion provider is registered for the same id. */
export const SQL_LANGUAGE = "sql";

/** Options for the SQL editor (exported so tests check what the real editor uses). */
export const SQL_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  fontSize: 14,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
  wordWrap: "on",
  renderLineHighlight: "line",
  // Suggest while typing (not only on Ctrl+Space), and after "." (trigger character).
  quickSuggestions: { other: "on", comments: "off", strings: "off" },
  quickSuggestionsDelay: 50,
  suggestOnTriggerCharacters: true,
  fixedOverflowWidgets: true,
};

let initialized = false;

/** Use the bundled Monaco (not the CDN) and its local worker. Safe to call repeatedly. */
export function setupMonaco(): void {
  if (initialized) return;
  initialized = true;
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
  loader.config({ monaco });
}

let registration: monaco.IDisposable | null = null;
let users = 0;

/**
 * Register the SQL completion provider while at least one editor uses it.
 * Reference-counted: calling it twice (e.g. React StrictMode effects) still
 * registers only one provider, so suggestions never show up twice. Dispose the
 * returned handle on unmount; the provider is removed when the last user goes.
 */
export function registerSqlCompletion(): monaco.IDisposable {
  users += 1;
  registration ??= monaco.languages.registerCompletionItemProvider(SQL_LANGUAGE, sqlCompletionProvider);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      users -= 1;
      if (users === 0) {
        registration?.dispose();
        registration = null;
      }
    },
  };
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

export const sqlCompletionProvider: monaco.languages.CompletionItemProvider = {
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
          let target = resolveQualifier(qualifier, refs, schemas);
          if (target?.kind === "columns") {
            const found = await columnsOf(connectionId, target, schema);
            if (found) {
              for (const c of found.columns) {
                add(c.name, Kind.Field, `${c.type}${c.primary_key ? " · PK" : ""}`, quoteIdent(c.name, dbType), "1");
              }
              return { suggestions };
            }
            // While typing "FROM sales." the FROM regex sees "sales" as a table name.
            // No such table: treat the qualifier as a schema instead.
            target = resolveQualifier(qualifier, [], schemas);
          }
          if (target?.kind === "tables") {
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
