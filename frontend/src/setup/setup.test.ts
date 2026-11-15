/** Part 14 round 2: the setup wizard's pure parts (starter query from foreign keys, marks,
 * names, drafts). */
import { describe, expect, it } from "vitest";
import type { Dataset, DiagramColumn, SchemaDiagram } from "../api.ts";
import type { ChartState } from "../charts/model.ts";
import { freeName, suggestChartName } from "./chartName.ts";
import { markedSettings } from "./datasetFromQuery.ts";
import { readDraft } from "./draft.ts";
import { defaultMark, joinPlan, markKey, marksForDataset, relations, starterSql, suggestedDatasetName } from "./starterSql.ts";

const col = (name: string, type: string, extra: Partial<DiagramColumn> = {}): DiagramColumn => ({
  name, type, nullable: true, primary_key: false, foreign_key: false, ...extra,
});  // prettier-ignore

/** The prototype's sales schema. */
const SALES: SchemaDiagram = {
  schema_name: "sales",
  truncated: false,
  tables: [
    { name: "orders", type: "table", columns: [col("order_id", "integer", { primary_key: true }), col("order_date", "date"), col("customer_id", "integer", { foreign_key: true }), col("channel", "varchar(20)"), col("status", "text")] },
    { name: "order_items", type: "table", columns: [col("order_id", "integer", { foreign_key: true }), col("product_id", "integer", { foreign_key: true }), col("quantity", "integer"), col("unit_price", "numeric(10,2)")] },
    { name: "products", type: "table", columns: [col("product_id", "integer", { primary_key: true }), col("name", "text"), col("category", "text")] },
    { name: "customers", type: "table", columns: [col("customer_id", "integer", { primary_key: true }), col("name", "text"), col("country", "text"), col("signed_up", "timestamp without time zone")] },
    { name: "audit_log", type: "table", columns: [col("id", "integer", { primary_key: true }), col("at", "timestamp")] },
  ],
  foreign_keys: [
    { name: null, table: "order_items", columns: ["order_id"], referred_schema: "sales", referred_table: "orders", referred_columns: ["order_id"] },
    { name: null, table: "order_items", columns: ["product_id"], referred_schema: "sales", referred_table: "products", referred_columns: ["product_id"] },
    { name: null, table: "orders", columns: ["customer_id"], referred_schema: "sales", referred_table: "customers", referred_columns: ["customer_id"] },
  ],
};  // prettier-ignore

describe("Explore: marks and relations", () => {
  it("marks dates as time and text (not keys) as breakdowns by default", () => {
    expect(defaultMark(col("order_date", "date"))).toEqual({ time: true, group: false });
    expect(defaultMark(col("signed_up", "timestamp with time zone"))).toEqual({ time: true, group: false });
    expect(defaultMark(col("wait", "interval"))).toEqual({ time: false, group: false });
    expect(defaultMark(col("channel", "varchar(20)"))).toEqual({ time: false, group: true });
    expect(defaultMark(col("customer_code_id", "text"))).toEqual({ time: false, group: false });
    expect(defaultMark(col("quantity", "integer"))).toEqual({ time: false, group: false });
  });

  it("lists the foreign keys of a table", () => {
    expect(relations(SALES, "orders")).toEqual(["order_items → orders via order_id", "orders → customers via customer_id"]);
    expect(relations(SALES, "audit_log")).toEqual([]);
  });
});

describe("Query: the starter query", () => {
  it("joins the picked table with its neighbors along the foreign keys", () => {
    const plan = joinPlan(SALES, "orders");
    expect(plan.joins.map((j) => `${j.table} ${j.alias}`)).toEqual(["order_items oi", "customers c", "products p"]);
    expect(plan.alias).toBe("o");
  });

  it("selects time columns, breakdowns and number columns (no keys); repeated names get the table", () => {
    const { sql, columns } = starterSql(SALES, "orders", {}, "postgresql");
    expect(sql).toBe(
      [
        'SELECT o."order_date",',
        '       c."signed_up",',
        '       o."channel",',
        '       o."status",',
        '       c."name",',
        '       c."country",',
        '       p."name" AS "products_name",',
        '       p."category",',
        '       oi."quantity",',
        '       oi."unit_price"',
        'FROM "sales"."orders" o',
        'JOIN "sales"."order_items" oi ON oi."order_id" = o."order_id"',
        'JOIN "sales"."customers" c ON o."customer_id" = c."customer_id"',
        'JOIN "sales"."products" p ON oi."product_id" = p."product_id"',
      ].join("\n"),
    );
    expect(columns.find((c) => c.output === "products_name")).toMatchObject({ table: "products", column: "name" });
  });

  it("follows the user's marks and quotes for MySQL", () => {
    const marks = { [markKey("audit_log", "at")]: { time: false, group: false } };
    const { sql } = starterSql(SALES, "audit_log", marks, "mysql");
    expect(sql).toBe("SELECT al.*\nFROM `sales`.`audit_log` al");
  });

  it("maps a dataset's columns back to the marks", () => {
    const { columns } = starterSql(SALES, "orders", { [markKey("orders", "status")]: { time: false, group: false } }, "postgresql");
    const marks = marksForDataset(["order_date", "status", "products_name", "other"], columns, {});
    expect(marks.get("order_date")).toEqual({ time: true, group: false });
    expect(marks.has("status")).toBe(false); // unmarked: not in the starter query any more
    expect(marks.get("products_name")).toEqual({ time: false, group: true });
    expect(marks.has("other")).toBe(false);
  });

  it("suggests a dataset name like the prototype", () => {
    expect(suggestedDatasetName("orders", true)).toBe("Order lines");
    expect(suggestedDatasetName("sales_2024", false)).toBe("Sales 2024");
  });
});

describe("Saving the dataset and the chart", () => {
  const dataset = {
    id: 4, name: "Order lines", main_time_column: null,
    columns: [
      { id: 1, name: "order_date", generic_type: "date", generic_type_override: null, is_temporal: false, is_dimension: false, is_hidden: false, is_missing: false, label: null, description: null },
      { id: 2, name: "channel", generic_type: "text", generic_type_override: null, is_temporal: false, is_dimension: false, is_hidden: false, is_missing: false, label: null, description: null },
      { id: 3, name: "code", generic_type: "text", generic_type_override: null, is_temporal: false, is_dimension: false, is_hidden: false, is_missing: false, label: null, description: null },
    ],
    metrics: [{ id: 1, name: "count", label: "Count", expression: "COUNT(*)", description: null, number_format: null, is_builtin: true }],
  } as unknown as Dataset;  // prettier-ignore

  it("marks time only on date columns (never fails on text) and picks the main time column", () => {
    const marks = new Map([
      ["order_date", { time: true, group: false }],
      ["channel", { time: false, group: true }],
      ["code", { time: true, group: false }],
    ]);
    const { columns, mainTime } = markedSettings(dataset, marks);
    expect(columns.map((c) => [c.id, c.is_temporal, c.is_dimension])).toEqual([
      [1, true, false],
      [2, false, true],
      [3, false, false],
    ]);
    expect(mainTime).toBe("order_date");
  });

  it("suggests a chart name and a free dashboard name", () => {
    const base: ChartState = { vizType: "big_number", query: { dataset_id: 4, metrics: ["count"], dimensions: [], series: null, columns: [], time: null, filters: [], order_by: null, row_limit: 1000, series_limit: 10 }, display: {} };
    expect(suggestChartName(base, dataset)).toBe("Total count");
    expect(suggestChartName({ ...base, vizType: "bar", query: { ...base.query, dimensions: ["channel"] } }, dataset)).toBe("Count by channel");
    expect(freeName("Overview", [])).toBe("Overview");
    expect(freeName("Overview", ["overview", "Overview 2"])).toBe("Overview 3");
  });

  it("reads a stored draft safely; the chart step resumes on its query", () => {
    expect(readDraft(null)).toBeNull();
    expect(readDraft({ step: "explore", source: "db", connectionId: 3 })).toMatchObject({ step: "explore", connectionId: 3, marks: {}, sql: null });
    expect(readDraft({ step: "chart", datasetId: 7 })?.step).toBe("query");
    expect(readDraft({ step: "nonsense" })?.step).toBe("source");
  });
});
