import { test, expect } from "bun:test";
import { BUILTIN_THEMES, THEME_KEYS, isPalette, migratePalette, themeByName } from "./themes";

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

test("migratePalette fills tokens missing from a stale stored custom palette", () => {
  // a custom palette saved before good/accent/focus existed: complete-but-old.
  const legacy: Record<string, string> = {};
  for (const k of THEME_KEYS) legacy[k] = (BUILTIN_THEMES[0].palette as any)[k];
  delete legacy["good"];
  delete legacy["accent"];
  delete legacy["focus"];
  expect(isPalette(legacy)).toBe(false); // strict check would reject it
  const migrated = migratePalette(legacy)!;
  expect(migrated).not.toBeNull();
  expect(isPalette(migrated)).toBe(true); // ...but migration makes it whole again
  // user's own colors are preserved; only the missing tokens are defaulted.
  expect(migrated.bg).toBe(legacy.bg);
  expect(migrated.good).toBe(BUILTIN_THEMES[0].palette.good);
  expect(migrated.accent).toBe(BUILTIN_THEMES[0].palette.accent);
  expect(migrated.focus).toBe(BUILTIN_THEMES[0].palette.focus);
});

test("migratePalette preserves a user override of a newly-added token", () => {
  const custom: Record<string, string> = {};
  for (const k of THEME_KEYS) custom[k] = (BUILTIN_THEMES[1].palette as any)[k];
  custom["accent"] = "#123456";
  expect(migratePalette(custom)!.accent).toBe("#123456");
});

test("migratePalette rejects values that are not a palette at all", () => {
  expect(migratePalette(null)).toBeNull();
  expect(migratePalette(42)).toBeNull();
  expect(migratePalette({ nope: 1 })).toBeNull(); // no surfaces/text → not adopted
});
