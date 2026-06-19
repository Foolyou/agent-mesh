import { test, expect } from "bun:test";
import { BUILTIN_THEMES, THEME_KEYS, isPalette, isHexColor, migratePalette, themeByName } from "./themes";

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

test("migratePalette seeds a missing link from the palette's OWN info (not the default)", () => {
  // `link` was promoted from a bare CSS var to a first-class token; a custom palette
  // saved before that has no `link`. It must inherit the palette's own info hue so an
  // upgrade doesn't recolor the user's links to the default theme's link.
  const legacy: Record<string, string> = {};
  for (const k of THEME_KEYS) legacy[k] = (BUILTIN_THEMES[1].palette as any)[k]; // amber
  delete legacy["link"];
  expect(isPalette(legacy)).toBe(false); // strict check rejects the missing token
  const m = migratePalette(legacy)!;
  expect(isPalette(m)).toBe(true);
  expect(m.link).toBe(BUILTIN_THEMES[1].palette.info); // amber's own info
  expect(m.link).not.toBe(BUILTIN_THEMES[0].palette.link); // NOT the default theme's link
});

test("migratePalette falls back to the default link when the palette's info is also unusable", () => {
  const legacy: Record<string, unknown> = {};
  for (const k of THEME_KEYS) legacy[k] = (BUILTIN_THEMES[2].palette as any)[k]; // ice
  delete legacy["link"];
  legacy["info"] = "not-a-color"; // info can't seed link either
  const m = migratePalette(legacy)!;
  expect(isPalette(m)).toBe(true);
  expect(m.link).toBe(BUILTIN_THEMES[0].palette.link); // default link fallback
  expect(m.info).toBe(BUILTIN_THEMES[0].palette.info); // malformed info defaulted as usual
});

test("migratePalette keeps a user's explicit link override", () => {
  const custom: Record<string, string> = {};
  for (const k of THEME_KEYS) custom[k] = (BUILTIN_THEMES[3].palette as any)[k]; // paper
  custom["link"] = "#123456";
  expect(migratePalette(custom)!.link).toBe("#123456");
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

test("isHexColor accepts #rgb / #rrggbb and rejects arbitrary strings", () => {
  for (const ok of ["#fff", "#FFFFFF", "#0a0b0d", " #1c1b18 "]) expect(isHexColor(ok)).toBe(true);
  for (const bad of ["red", "#zzz", "#12", "#1234", "rgb(0,0,0)", "", 42, null, "javascript:alert(1)"])
    expect(isHexColor(bad as any)).toBe(false);
});

test("migratePalette defaults malformed token values instead of writing them into CSS vars", () => {
  const custom: Record<string, unknown> = {};
  for (const k of THEME_KEYS) custom[k] = (BUILTIN_THEMES[2].palette as any)[k];
  custom["accent"] = "red"; // not hex
  custom["focus"] = "#zzzzzz"; // malformed hex
  custom["good"] = "url(evil)"; // arbitrary string
  const m = migratePalette(custom)!;
  expect(isPalette(m)).toBe(true); // every value is a valid hex
  expect(m.bg).toBe(BUILTIN_THEMES[2].palette.bg); // valid value preserved
  expect(m.accent).toBe(BUILTIN_THEMES[0].palette.accent); // malformed → default
  expect(m.focus).toBe(BUILTIN_THEMES[0].palette.focus);
  expect(m.good).toBe(BUILTIN_THEMES[0].palette.good);
});

test("migratePalette rejects an object whose only anchor colors are malformed", () => {
  expect(migratePalette({ bg: "nope", fg: "alsonope", line: "#fff" })).toBeNull();
});
