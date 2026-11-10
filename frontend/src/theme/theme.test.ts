import { afterEach, describe, expect, it, vi } from "vitest";
import { getTheme, resolveTheme, setThemePreference, THEME_STORAGE_KEY, toggleTheme } from "./theme.ts";

afterEach(() => {
  setThemePreference("system");
});

describe("theme", () => {
  it("resolves system to the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("applies and remembers the preference", () => {
    setThemePreference("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(getTheme()).toEqual({ preference: "dark", resolved: "dark" });

    toggleTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(getTheme().preference).toBe("light");
  });

  it("still switches when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setThemePreference("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
