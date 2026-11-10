import type { SchemaDiagram } from "../api.ts";

/** The demo database's sales schema, as the diagram endpoint returns it. */
export const col = (name: string, extra: Partial<{ primary_key: boolean; foreign_key: boolean }> = {}) => ({
  name,
  type: "INTEGER",
  nullable: false,
  primary_key: false,
  foreign_key: false,
  ...extra,
});

export const SALES: SchemaDiagram = {
  schema_name: "sales",
  truncated: false,
  tables: [
    { name: "customers", type: "table", columns: [col("id", { primary_key: true }), col("name")] },
    { name: "order_items", type: "table", columns: [col("id", { primary_key: true }), col("order_id", { foreign_key: true }), col("product_id", { foreign_key: true })] },
    { name: "order_totals", type: "view", columns: [col("order_id"), col("total")] },
    { name: "orders", type: "table", columns: [col("id", { primary_key: true }), col("customer_id", { foreign_key: true })] },
    { name: "products", type: "table", columns: [col("id", { primary_key: true })] },
  ],
  foreign_keys: [
    { name: "fk1", table: "orders", columns: ["customer_id"], referred_schema: "sales", referred_table: "customers", referred_columns: ["id"] },
    { name: "fk2", table: "order_items", columns: ["order_id"], referred_schema: "sales", referred_table: "orders", referred_columns: ["id"] },
    { name: "fk3", table: "order_items", columns: ["product_id"], referred_schema: "sales", referred_table: "products", referred_columns: ["id"] },
  ],
};

