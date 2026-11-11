/** Matching country values (ISO-2, ISO-3 or a name in any common form) to map shapes. Pure. */
import { COUNTRY_ALIASES } from "./countryAliases.ts";
import { COUNTRIES } from "./countries.ts";

/** "Côte d'Ivoire" -> "cote d ivoire"; "The Bahamas" -> "bahamas"; "&" -> "and". */
export function normalizeCountry(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

type Index = { codes: Map<string, string>; names: Map<string, string> };
let built: Index | null = null;

function index(): Index {
  if (built) return built;
  const codes = new Map<string, string>();
  const names = new Map<string, string>();
  for (const [iso2, iso3, ...list] of COUNTRIES) {
    codes.set(iso2!, iso2!);
    if (iso3) codes.set(iso3, iso2!);
    for (const name of list) names.set(normalizeCountry(name), iso2!);
  }
  // Hand-written aliases win over generated names (e.g. "Congo" = the Republic of the Congo).
  for (const [key, list] of Object.entries(COUNTRY_ALIASES)) {
    for (const name of list) names.set(normalizeCountry(name), key);
  }
  built = { codes, names };
  return built;
}

/** The shape key (ISO-2, or a name for the few shapes without a code) of a value, or null. */
export function matchCountry(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const { codes, names } = index();
  // Codes only when written as codes ("US", "usa"), so a name like "Chad" isn't read as one.
  if (/^[A-Za-z]{2,3}$/.test(text)) {
    const code = codes.get(text.toUpperCase());
    if (code) return code;
  }
  return names.get(normalizeCountry(text)) ?? null;
}

export type CountryMatch = {
  /** Shape key -> the data rows' value (summed when several values match one country). */
  values: Map<string, number>;
  /** Shape key -> the names in the data that matched it (for tooltips). */
  labels: Map<string, string[]>;
  /** Values no country matched (shown so they can be fixed with dataset value labels). */
  unmatched: string[];
};

/** Match every row's country name; rows with the same country are added up. */
export function matchRows(rows: { name: string; value: number | null }[]): CountryMatch {
  const values = new Map<string, number>();
  const labels = new Map<string, string[]>();
  const unmatched: string[] = [];
  for (const row of rows) {
    const key = matchCountry(row.name);
    if (!key) {
      if (!unmatched.includes(row.name)) unmatched.push(row.name);
      continue;
    }
    values.set(key, (values.get(key) ?? 0) + (row.value ?? 0));
    labels.set(key, [...(labels.get(key) ?? []), row.name]);
  }
  return { values, labels, unmatched };
}
