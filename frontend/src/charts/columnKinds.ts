/** How a column shows in the chart editor's column list: an icon and a word for its type. */
import { Calendar, CalendarClock, CalendarRange, Hash, Shapes, ToggleLeft, Type } from "lucide-react";
import type { DatasetColumn } from "../api.ts";

/** The drag payload: a column name. */
export const COLUMN_MIME = "application/x-vita-column";

/** An icon and a word for a column's type ("year" for a year number, "text date"...). */
export function columnKind(c: DatasetColumn): { icon: typeof Hash; word: string } {
  if (c.time_kind === "year_number") return { icon: CalendarRange, word: "year" };
  if (c.time_kind === "text_date") return { icon: Calendar, word: "text date" };
  switch (c.effective_type) {
    case "number":
      return { icon: Hash, word: c.is_identifier ? "identifier" : "number" };
    case "string":
      return { icon: Type, word: "text" };
    case "date":
      return { icon: Calendar, word: "date" };
    case "datetime":
      return { icon: CalendarClock, word: "date and time" };
    case "boolean":
      return { icon: ToggleLeft, word: "yes / no" };
    default:
      return { icon: Shapes, word: "other" };
  }
}
