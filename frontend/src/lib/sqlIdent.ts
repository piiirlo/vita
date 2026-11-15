import type { DbType } from "../api.ts";

/** A quoted identifier for the connection's database. */
export function quoteIdentifier(name: string, dbType: DbType): string {
  return dbType === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}
