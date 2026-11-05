/**
 * Uses the REAL Monaco (not the textarea mock of the page tests): the language id,
 * the suggest widget being loaded, the editor options, and the completion provider
 * itself with mocked metadata (fetch). Guards the "autocomplete does nothing" bug.
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SQL_EDITOR_OPTIONS,
  SQL_LANGUAGE,
  registerSqlCompletion,
  setCompletionContext,
  sqlCompletionProvider,
} from "./monacoSetup.ts";
import { clearAllCaches } from "./schemaCache.ts";

const TABLES = [
  { name: "orders", type: "table" },
  { name: "customers", type: "table" },
  { name: "order_totals", type: "view" },
];
const ORDER_COLUMNS = [
  { name: "id", type: "integer", nullable: false, primary_key: true },
  { name: "customer_id", type: "integer", nullable: false, primary_key: false },
  { name: "status", type: "text", nullable: false, primary_key: false },
];

function mockMetadata(): string[] {
  const requested: string[] = [];
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === "/api/connections/1/schemas") return respond(["public", "sales"]);
      if (url === "/api/connections/1/schemas/public/tables") return respond([]);
      if (url === "/api/connections/1/schemas/sales/tables") return respond(TABLES);
      if (url === "/api/connections/1/schemas/sales/tables/orders/columns") return respond(ORDER_COLUMNS);
      return respond({ detail: `unexpected ${url}` }, 404);
    }),
  );
  return requested;
}

const models: monaco.editor.ITextModel[] = [];

/** Ask the provider for suggestions with the cursor at the end of `sql`. */
async function suggest(sql: string, triggerCharacter?: string): Promise<string[]> {
  const model = monaco.editor.createModel(sql, SQL_LANGUAGE);
  models.push(model);
  const lastLine = model.getLineCount();
  const position = new monaco.Position(lastLine, model.getLineMaxColumn(lastLine));
  const context: monaco.languages.CompletionContext = triggerCharacter
    ? { triggerKind: monaco.languages.CompletionTriggerKind.TriggerCharacter, triggerCharacter }
    : { triggerKind: monaco.languages.CompletionTriggerKind.Invoke };
  const token = new monaco.CancellationTokenSource().token;
  const result = await sqlCompletionProvider.provideCompletionItems(model, position, context, token);
  return (result?.suggestions ?? []).map((s) => (typeof s.label === "string" ? s.label : s.label.label));
}

beforeEach(() => {
  clearAllCaches();
  setCompletionContext({ connectionId: 1, schema: "sales", dbType: "postgresql" });
});

afterEach(() => {
  models.splice(0).forEach((m) => m.dispose());
  setCompletionContext({ connectionId: null, schema: null, dbType: "postgresql" });
});

describe("Monaco setup", () => {
  it("knows the 'sql' language the editor and the provider use", () => {
    expect(SQL_LANGUAGE).toBe("sql");
    expect(monaco.languages.getLanguages().map((l) => l.id)).toContain("sql");
  });

  it("loads the suggest widget and suggests while typing and after '.'", () => {
    // jsdom has no canvas; Monaco only reads a pixel ratio from it.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    const editor = monaco.editor.create(document.createElement("div"), {
      ...SQL_EDITOR_OPTIONS,
      language: SQL_LANGUAGE,
    });
    try {
      // The original bug: `editor.api` alone has no suggest controller, so nothing
      // ever asked the provider for completions.
      expect(editor.getContribution("editor.contrib.suggestController")).not.toBeNull();
      expect(editor.getOption(monaco.editor.EditorOption.quickSuggestions)).toMatchObject({ other: "on" });
      expect(editor.getOption(monaco.editor.EditorOption.suggestOnTriggerCharacters)).toBe(true);
    } finally {
      editor.dispose();
    }
    expect(sqlCompletionProvider.triggerCharacters).toContain(".");
  });

  it("registers the provider once for 'sql' and removes it when the last editor goes", () => {
    const remove = vi.fn();
    const register = vi
      .spyOn(monaco.languages, "registerCompletionItemProvider")
      .mockReturnValue({ dispose: remove });

    const first = registerSqlCompletion();
    const second = registerSqlCompletion(); // e.g. StrictMode running the effect twice
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("sql", sqlCompletionProvider);

    first.dispose();
    first.dispose(); // disposing twice must not remove it for the other user
    expect(remove).not.toHaveBeenCalled();
    second.dispose();
    expect(remove).toHaveBeenCalledTimes(1);

    registerSqlCompletion().dispose(); // can register again after a full cleanup
    expect(register).toHaveBeenCalledTimes(2);
  });
});

describe("SQL completion provider (real Monaco model)", () => {
  it("suggests keywords while typing 'SEL'", async () => {
    mockMetadata();
    expect(await suggest("SEL")).toContain("SELECT");
  });

  it("lists the tables of a schema after 'sales.'", async () => {
    const requested = mockMetadata();
    const labels = await suggest("SELECT * FROM sales.", ".");
    expect(labels).toEqual(expect.arrayContaining(["orders", "customers", "order_totals"]));
    expect(labels).not.toContain("SELECT"); // only tables after a qualifier
    expect(requested).toContain("/api/connections/1/schemas/sales/tables");
  });

  it("lists the columns of an aliased table after 'o.'", async () => {
    const requested = mockMetadata();
    const labels = await suggest("SELECT * FROM sales.orders o WHERE o.", ".");
    expect(labels).toEqual(["id", "customer_id", "status"]);
    expect(requested).toContain("/api/connections/1/schemas/sales/tables/orders/columns");
  });

  it("suggests columns of referenced tables and tables of the selected schema", async () => {
    mockMetadata();
    const labels = await suggest("SELECT st FROM orders WHERE ");
    expect(labels).toEqual(expect.arrayContaining(["status", "customers", "SELECT"]));
  });

  it("fetches metadata once per connection, not on every keystroke", async () => {
    const requested = mockMetadata();
    await suggest("SELECT * FROM sales.orders o WHERE o.", ".");
    await suggest("SELECT * FROM sales.orders o WHERE o.st", ".");
    const columnRequests = requested.filter((u) => u.endsWith("/orders/columns"));
    expect(columnRequests).toHaveLength(1);
    // A half-typed table name never causes a columns request.
    await suggest("SELECT * FROM sales.ord x WHERE x.", ".");
    expect(requested.filter((u) => u.includes("/ord/"))).toHaveLength(0);
  });

  it("still suggests keywords without a connection", async () => {
    const requested = mockMetadata();
    setCompletionContext({ connectionId: null, schema: null, dbType: "postgresql" });
    expect(await suggest("SEL")).toContain("SELECT");
    expect(requested).toHaveLength(0);
  });
});
