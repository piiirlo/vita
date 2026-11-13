import { describe, expect, it } from "vitest";
import { readableDate } from "./uploads.ts";

describe("readableDate", () => {
  it("shows dates so they can't be misread", () => {
    // Superstore: day first, "/" and "-" mixed between values.
    expect(readableDate("9/11/2013", "dmy", false)).toBe("9 Nov 2013");
    expect(readableDate("13-06-2013", "dmy", false)).toBe("13 Jun 2013");
    expect(readableDate("9/11/2013", "mdy", false)).toBe("11 Sep 2013");
    expect(readableDate("2013-11-09", "ymd", false)).toBe("9 Nov 2013");
    expect(readableDate("2013-11-09 14:05:00", "ymd", true)).toBe("9 Nov 2013 14:05");
    expect(readableDate("2013-11-09 14:05:00", "ymd", false)).toBe("9 Nov 2013");
  });

  it("returns null for values that aren't a date in that order", () => {
    expect(readableDate("13/13/2013", "dmy", false)).toBeNull();
    expect(readableDate("30/02/2013", "dmy", false)).toBeNull();
    expect(readableDate("2013-11-09", "dmy", false)).toBeNull();
    expect(readableDate("9/11/13", "dmy", false)).toBeNull();
    expect(readableDate("N/A", "dmy", false)).toBeNull();
  });
});
