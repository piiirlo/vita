import { describe, expect, it } from "vitest";
import {
  cellText,
  csvFilename,
  editorErrorPosition,
  formatDuration,
  nextSort,
  sortRows,
  toCsv,
} from "./results.ts";

describe("sortRows", () => {
  const rows = [[3, "b"], [null, "a"], [10, null], [1, "c"]];

  it("sorts numbers numerically with NULLs last in both directions", () => {
    expect(sortRows(rows, { column: 0, desc: false }, ["number", "string"]).map((r) => r[0])).toEqual([1, 3, 10, null]);
    expect(sortRows(rows, { column: 0, desc: true }, ["number", "string"]).map((r) => r[0])).toEqual([10, 3, 1, null]);
  });

  it("sorts strings and keeps the original order when unsorted", () => {
    expect(sortRows(rows, { column: 1, desc: false }, ["number", "string"]).map((r) => r[1])).toEqual(["a", "b", "c", null]);
    expect(sortRows(rows, null, ["number", "string"])).toBe(rows);
  });

  it("sorts ISO dates and numbers-as-strings correctly", () => {
    const dates = [["2025-10-01"], ["2024-12-31"], ["2025-02-03"]];
    expect(sortRows(dates, { column: 0, desc: false }, ["date"]).map((r) => r[0])).toEqual([
      "2024-12-31", "2025-02-03", "2025-10-01",
    ]); // prettier-ignore
    const big = [["100000000000000000000.5"], ["9.25"]];
    expect(sortRows(big, { column: 0, desc: false }, ["number"]).map((r) => r[0])).toEqual([
      "9.25", "100000000000000000000.5",
    ]); // prettier-ignore
  });

  it("cycles asc -> desc -> off", () => {
    expect(nextSort(null, 2)).toEqual({ column: 2, desc: false });
    expect(nextSort({ column: 2, desc: false }, 2)).toEqual({ column: 2, desc: true });
    expect(nextSort({ column: 2, desc: true }, 2)).toBeNull();
    expect(nextSort({ column: 2, desc: true }, 0)).toEqual({ column: 0, desc: false });
  });
});

describe("toCsv", () => {
  it("escapes quotes, commas, newlines; NULL is empty; objects are JSON", () => {
    const csv = toCsv(
      ["id", "name", "note", "data"],
      [
        [1, 'He said "hi"', "a,b", { x: 1 }],
        [2, null, "line1\nline2", [1, 2]],
        [3, " padded", true, 1.5],
      ],
    );
    expect(csv).toBe(
      'id,name,note,data\r\n' +
        '1,"He said ""hi""","a,b","{""x"":1}"\r\n' +
        '2,,"line1\nline2","[1,2]"\r\n' +
        '3," padded",true,1.5\r\n',
    );
  });

  it("makes a safe file name", () => {
    expect(csvFilename("Revenue / month!", new Date("2026-11-05T10:20:30Z"))).toBe(
      "Revenue_month_2026-11-05-10-20-30.csv",
    );
  });
});

describe("cellText and formatDuration", () => {
  it("formats values", () => {
    expect(cellText(null)).toBe("NULL");
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText(false)).toBe("false");
    expect(formatDuration(42)).toBe("42 ms");
    expect(formatDuration(1500)).toBe("1.50 s");
    expect(formatDuration(30_100)).toBe("30.1 s");
  });
});

describe("editorErrorPosition", () => {
  it("is unchanged when the whole editor was run", () => {
    expect(editorErrorPosition({ line: 3, column: 5 }, { startLine: 1, startColumn: 1 })).toEqual({ line: 3, column: 5 });
  });

  it("shifts by the selection start (first line also by column)", () => {
    const offset = { startLine: 4, startColumn: 9 };
    expect(editorErrorPosition({ line: 1, column: 3 }, offset)).toEqual({ line: 4, column: 11 });
    expect(editorErrorPosition({ line: 2, column: 3 }, offset)).toEqual({ line: 5, column: 3 });
  });

  it("handles a missing column or line", () => {
    expect(editorErrorPosition({ line: 2, column: null }, { startLine: 1, startColumn: 1 })).toEqual({ line: 2, column: null });
    expect(editorErrorPosition({ line: null, column: null }, { startLine: 1, startColumn: 1 })).toBeNull();
  });
});
