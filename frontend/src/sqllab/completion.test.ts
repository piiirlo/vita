import { describe, expect, it } from "vitest";
import {
  extractTableRefs,
  qualifiedName,
  qualifierBeforeCursor,
  quoteIdent,
  resolveQualifier,
} from "./completion.ts";

describe("extractTableRefs", () => {
  it("finds tables, schemas and aliases in FROM and JOIN", () => {
    const sql = `SELECT o.id, c.name
      FROM sales.orders o
      JOIN sales.customers AS c ON c.id = o.customer_id
      LEFT JOIN products p ON true
      WHERE o.status = 'x'`;
    expect(extractTableRefs(sql)).toEqual([
      { schema: "sales", table: "orders", alias: "o" },
      { schema: "sales", table: "customers", alias: "c" },
      { schema: null, table: "products", alias: "p" },
    ]);
  });

  it("does not treat keywords as aliases", () => {
    expect(extractTableRefs("SELECT * FROM orders WHERE id = 1")).toEqual([
      { schema: null, table: "orders", alias: null },
    ]);
    expect(extractTableRefs("SELECT * FROM a JOIN b ON a.id = b.id")[0]?.alias).toBeNull();
  });

  it("handles quoted identifiers", () => {
    expect(extractTableRefs('SELECT * FROM "Sales"."Order Items" "oi"')).toEqual([
      { schema: "Sales", table: "Order Items", alias: "oi" },
    ]);
    expect(extractTableRefs("SELECT * FROM `Rfam`.family f")).toEqual([
      { schema: "Rfam", table: "family", alias: "f" },
    ]);
  });
});

describe("qualifierBeforeCursor / resolveQualifier", () => {
  const refs = extractTableRefs("SELECT FROM sales.orders o JOIN customers c ON true");

  it("reads the identifier before a dot", () => {
    expect(qualifierBeforeCursor("SELECT o.")).toBe("o");
    expect(qualifierBeforeCursor('SELECT "My Table".')).toBe("My Table");
    expect(qualifierBeforeCursor("SELECT o")).toBeNull();
  });

  it("resolves aliases, table names and schemas", () => {
    expect(resolveQualifier("o", refs, ["sales"])).toEqual({ kind: "columns", schema: "sales", table: "orders" });
    expect(resolveQualifier("C", refs, ["sales"])).toEqual({ kind: "columns", schema: null, table: "customers" });
    expect(resolveQualifier("orders", refs, ["sales"])).toEqual({ kind: "columns", schema: "sales", table: "orders" });
    expect(resolveQualifier("sales", [], ["public", "sales"])).toEqual({ kind: "tables", schema: "sales" });
    expect(resolveQualifier("nope", refs, ["sales"])).toBeNull();
  });
});

describe("quoteIdent", () => {
  it("quotes only when needed, per dialect", () => {
    expect(quoteIdent("orders", "postgresql")).toBe("orders");
    expect(quoteIdent("Orders", "postgresql")).toBe('"Orders"');
    expect(quoteIdent("order items", "postgresql")).toBe('"order items"');
    expect(quoteIdent('a"b', "postgresql")).toBe('"a""b"');
    expect(quoteIdent("Rfam", "mysql")).toBe("Rfam");
    expect(quoteIdent("my table", "mysql")).toBe("`my table`");
    expect(qualifiedName("sales", "orders", "postgresql")).toBe("sales.orders");
    expect(qualifiedName("Rfam", "family", "postgresql")).toBe('"Rfam".family');
  });
});
