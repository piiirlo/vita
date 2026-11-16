/** Cross-filtering (Part 15): what clicking a chart element selects. Pure. */
import type { Dataset, FilterScalar } from "../api.ts";
import { splitDim } from "./dimensions.ts";

/** One column = one of these values. */
export type CrossCondition = { column: string; values: FilterScalar[] };
/** What a click selects: a condition per dimension of the element (a pivot cell: its row and
 * column values). */
export type CrossSelection = CrossCondition[];
export type OnCrossSelect = (selection: CrossSelection) => void;

function scalar(value: unknown): FilterScalar | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

/** (dimension ref, raw value) pairs -> a selection. Only plain columns can filter other charts:
 * date buckets and time parts ("order_date@month") are left out. Null: nothing to filter on. */
export function crossSelection(pairs: [string | undefined, unknown][], dataset: Dataset | null): CrossSelection | null {
  const out: CrossSelection = [];
  for (const [ref, raw] of pairs) {
    if (!ref || splitDim(ref, dataset).part) continue;
    const value = scalar(raw);
    if (value === undefined) continue;
    out.push({ column: ref, values: [value] });
  }
  return out.length ? out : null;
}

/** A world-map country: every raw value that matched it. */
export function countrySelection(ref: string | undefined, raws: unknown[], dataset: Dataset | null): CrossSelection | null {
  if (!ref || splitDim(ref, dataset).part || raws.length === 0) return null;
  const values = raws.map(scalar).filter((v): v is FilterScalar => v !== undefined);
  return values.length ? [{ column: ref, values }] : null;
}

const norm = (sel: CrossSelection) =>
  JSON.stringify([...sel].map((c) => [c.column, [...c.values].map((v) => JSON.stringify(v)).sort()]).sort());

export function sameSelection(a: CrossSelection | null | undefined, b: CrossSelection | null | undefined): boolean {
  return !!a && !!b && norm(a) === norm(b);
}
