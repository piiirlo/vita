/** The connection form's values and checks (the Connections page and the setup wizard). */
import { DEFAULT_PORTS, type ConnectionFields, type DbType } from "../api.ts";

/** Form values are kept as strings; converted when submitting. */
export type FormState = {
  name: string;
  db_type: DbType;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  /** Edit form only: "No password" checkbox, clears the saved password. */
  noPassword: boolean;
  extra: string;
};

export const EMPTY_FORM: FormState = {
  name: "",
  db_type: "postgresql",
  host: "",
  port: String(DEFAULT_PORTS.postgresql),
  database: "",
  username: "",
  password: "",
  noPassword: false,
  extra: "",
};

/** Soft check for a common mistake: typing the host name into the Database field. */
export function looksLikeHostname(database: string, host: string): boolean {
  const db = database.trim().toLowerCase();
  if (!db) return false;
  return db.includes(".") || db === host.trim().toLowerCase();
}

/**
 * New port after switching database type: only replace it when it's empty or
 * still the other type's default, so a custom port is never overwritten.
 */
export function portAfterTypeChange(currentPort: string, from: DbType, to: DbType): string {
  const port = currentPort.trim();
  if (port === "" || port === String(DEFAULT_PORTS[from])) return String(DEFAULT_PORTS[to]);
  return currentPort;
}

/** Validate and convert the form to API fields. Throws Error with a readable message. */
export function toFields(form: FormState): ConnectionFields {
  const missing = (["host", "database", "username"] as const).filter((k) => !form[k].trim());
  if (missing.length > 0) throw new Error(`Please fill in: ${missing.join(", ")}.`);

  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be a number between 1 and 65535.");
  }

  let extra: Record<string, unknown> | null = null;
  if (form.extra.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(form.extra);
    } catch {
      throw new Error("Extra options must be valid JSON.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error('Extra options must be a JSON object, e.g. {"sslmode": "require"}.');
    }
    extra = parsed as Record<string, unknown>;
  }

  return {
    db_type: form.db_type,
    host: form.host.trim(),
    port,
    database: form.database.trim(),
    username: form.username.trim(),
    password: form.noPassword ? "" : form.password,
    clear_password: form.noPassword,
    extra,
  };
}
