import { test, expect } from "bun:test";
import { BUILTIN_THEMES, THEME_KEYS, isPalette, themeByName } from "./themes";

test("every built-in theme defines all keys as valid hex colors", () => {
  expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(4);
  for (const t of BUILTIN_THEMES) {
    for (const k of THEME_KEYS) {
      const v = (t.palette as any)[k];
      expect(typeof v).toBe("string");
      expect(v).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  }
});

test("theme names are unique and have labels", () => {
  const names = BUILTIN_THEMES.map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
  for (const t of BUILTIN_THEMES) expect(t.label.length).toBeGreaterThan(0);
});

test("isPalette validates completeness", () => {
  expect(isPalette(BUILTIN_THEMES[0].palette)).toBe(true);
  expect(isPalette({ bg: "#000" })).toBe(false);
  expect(isPalette(null)).toBe(false);
});

test("themeByName falls back to the first theme", () => {
  expect(themeByName("nope").name).toBe(BUILTIN_THEMES[0].name);
  expect(themeByName("amber").name).toBe("amber");
});
