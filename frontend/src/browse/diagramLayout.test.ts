import { describe, expect, it } from "vitest";
import type { SchemaDiagram } from "../api.ts";
import { SALES, col } from "./testData.ts";
import { CARD_WIDTH, cardHeight, centerOn, fitAll, layoutDiagram, neighbors, quoteIdentifier, searchTables, selectAllSql } from "./diagramLayout.ts";

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("diagram layout", () => {
  it("places every table without overlaps, referenced tables to the left", () => {
    const layout = layoutDiagram(SALES, new Set());
    expect([...layout.nodes.keys()].sort()).toEqual(SALES.tables.map((t) => t.name).sort());
    const boxes = [...layout.nodes.values()];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
    const x = (name: string) => layout.nodes.get(name)!.x;
    expect(x("customers")).toBeLessThan(x("orders"));
    expect(x("orders")).toBeLessThan(x("order_items"));
    // The view has no keys: it goes in the rows below.
    expect(layout.nodes.get("order_totals")!.y).toBeGreaterThan(Math.max(...["customers", "orders", "order_items", "products"].map((n) => layout.nodes.get(n)!.y)));
    // One line per foreign key, with points from dagre.
    expect(layout.edges).toHaveLength(3);
    expect(layout.edges.every((e) => e.points.length >= 2)).toBe(true);
    expect(layout.edges[0]!.label).toBe("orders.customer_id → customers.id");
  });

  it("makes expanded cards taller (columns shown) and keeps them apart", () => {
    const collapsed = layoutDiagram(SALES, new Set());
    const expanded = layoutDiagram(SALES, new Set(["order_items"]));
    expect(expanded.nodes.get("order_items")!.height).toBe(cardHeight(3, true));
    expect(expanded.nodes.get("order_items")!.height).toBeGreaterThan(collapsed.nodes.get("order_items")!.height);
    expect(cardHeight(100, true)).toBe(cardHeight(17, true)); // long tables are capped
    expect(expanded.nodes.get("customers")!.width).toBe(CARD_WIDTH);
  });

  it("stays quick and tidy with 150 tables", () => {
    const many: SchemaDiagram = {
      schema_name: "big",
      truncated: false,
      tables: Array.from({ length: 150 }, (_, i) => ({ name: `t${i}`, type: "table" as const, columns: [col("id"), col("parent_id")] })),
      foreign_keys: Array.from({ length: 60 }, (_, i) => ({
        name: `fk${i}`,
        table: `t${i + 1}`,
        columns: ["parent_id"],
        referred_schema: "big",
        referred_table: `t${Math.floor(i / 3)}`,
        referred_columns: ["id"],
      })),
    };
    const start = performance.now();
    const layout = layoutDiagram(many, new Set());
    expect(performance.now() - start).toBeLessThan(3000);
    expect(layout.nodes.size).toBe(150);
    const boxes = [...layout.nodes.values()];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
  });

  it("finds neighbors and tables by name", () => {
    expect([...neighbors(SALES, "orders")].sort()).toEqual(["customers", "order_items"]);
    expect([...neighbors(SALES, "order_totals")]).toEqual([]);
    expect(searchTables(SALES, "ORD")).toEqual(["order_items", "order_totals", "orders"]);
    expect(searchTables(SALES, "item")).toEqual(["order_items"]);
    expect(searchTables(SALES, "  ")).toEqual([]);
  });

  it("quotes identifiers per database", () => {
    expect(quoteIdentifier('we"ird', "postgresql")).toBe('"we""ird"');
    expect(quoteIdentifier("we`ird", "mysql")).toBe("`we``ird`");
    expect(selectAllSql("sales", "orders", "postgresql", 20)).toBe('SELECT *\nFROM "sales"."orders"\nLIMIT 20');
  });

  it("centers a table and fits the whole diagram", () => {
    expect(centerOn({ x: 100, y: 50, width: 200, height: 100 }, { width: 800, height: 600 }, 1)).toEqual({ x: 200, y: 200, scale: 1 });
    const fit = fitAll({ width: 3000, height: 1000 }, { width: 800, height: 600 });
    expect(fit.scale).toBeCloseTo((800 - 32) / 3000);
    expect(fitAll({ width: 100, height: 100 }, { width: 800, height: 600 }).scale).toBe(1);
  });
});
