import { test, expect } from "bun:test";
import {
  MODES, ACCENTS, DEFAULT_MODE, DEFAULT_ACCENT, SEMANTIC_KEYS,
  compose, v1PaletteToSemantic, loadThemeSelection, BUILTIN_THEMES, isHexColor, applyPalette,
  type SemanticPalette,
} from "./themes";

const allHex = (p: SemanticPalette) => SEMANTIC_KEYS.every((k) => isHexColor(p[k]));

test("axes: 3 modes × 3 accents, default Dark·Slate × Signal Teal", () => {
  expect([...MODES]).toEqual(["dark-slate", "light-cool", "eye-care-warm"]);
  expect([...ACCENTS]).toEqual(["signal-teal", "ember", "fleet-azure"]);
  expect(DEFAULT_MODE).toBe("dark-slate");
  expect(DEFAULT_ACCENT).toBe("signal-teal");
});

test("compose() emits every semantic key as valid hex for all 9 combinations", () => {
  for (const m of MODES) for (const a of ACCENTS) {
    const p = compose(m, a);
    expect(Object.keys(p).sort()).toEqual([...SEMANTIC_KEYS].sort());
    expect(allHex(p)).toBe(true);
  }
});

test("compose() resolves the documented v2 values", () => {
  const dark = compose("dark-slate", "signal-teal");
  expect(dark.surface).toBe("#0e1117");
  expect(dark["surface-raised"]).toBe("#1b212a");
  expect(dark["text-primary"]).toBe("#e9eef4");
  expect(dark.accent).toBe("#2dd4bf");
  expect(dark.success).toBe("#4ade80");
  const light = compose("light-cool", "signal-teal");
  expect(light.surface).toBe("#eef3f8");
  expect(light.accent).toBe("#0f766e");
});

test("on-* is resolved by contrast, NOT assumed white (bright amber warning → near-black on Dark)", () => {
  expect(compose("dark-slate", "signal-teal")["on-warning"]).toBe("#0b0b0b"); // bright amber-400 fill
  expect(compose("light-cool", "signal-teal")["on-warning"]).toBe("#ffffff"); // dark amber-800 fill
  // accents: bright Dark fills take near-black, dark Light/Eye-care fills take white
  expect(compose("dark-slate", "signal-teal")["on-accent"]).toBe("#0b0b0b");
  expect(compose("light-cool", "signal-teal")["on-accent"]).toBe("#ffffff");
});

test("per-mode accent stop override: Eye-care × Ember = stop 800", () => {
  expect(compose("eye-care-warm", "ember").accent).toBe("#9a3412"); // ember-800
  expect(compose("eye-care-warm", "signal-teal").accent).toBe("#0f766e"); // teal-700 (no override)
});

test("status *-subtle differs from the surface (a real tint)", () => {
  const p = compose("dark-slate", "signal-teal");
  expect(p["danger-subtle"]).not.toBe(p.surface);
  expect(p["accent-subtle"]).not.toBe(p.surface);
});

test("v1 19-key → v2 semantic shim derives a complete palette from a stored v1 palette", () => {
  const v1 = BUILTIN_THEMES[0].palette; // phosphor
  const s = v1PaletteToSemantic(v1);
  expect(Object.keys(s).sort()).toEqual([...SEMANTIC_KEYS].sort());
  expect(allHex(s)).toBe(true);
  expect(s.surface).toBe(v1.bg);
  expect(s["text-primary"]).toBe(v1.fg);
  expect(s.accent).toBe(v1.accent);
  expect(s.success).toBe(v1.ok);
});

test("loadThemeSelection() falls back to the default selection without storage", () => {
  // bun test has no localStorage → getItem throws → defaults
  expect(loadThemeSelection()).toEqual({ mode: DEFAULT_MODE, accent: DEFAULT_ACCENT });
});

test("applyPalette keeps BOTH layers in sync (v1 preset → semantic vars, never stale)", () => {
  const store: Record<string, string> = {};
  const root = { style: { setProperty: (k: string, v: string) => { store[k] = v; } } };
  const g = globalThis as any;
  const prev = g.document;
  g.document = { documentElement: root };
  try {
    const paper = BUILTIN_THEMES.find((t) => t.name === "paper")!.palette;
    applyPalette(paper);
    expect(store["--bg"]).toBe(paper.bg); // legacy layer written
    expect(store["--surface"]).toBe(paper.bg); // v2 semantic layer ALSO written (surface = v1 bg)
    expect(store["--accent"]).toBe(paper.accent);
    expect(store["--on-danger"]).toBeTruthy(); // derived semantic token present
    // switching to another preset must refresh the semantic layer (not leave paper stale)
    const amber = BUILTIN_THEMES.find((t) => t.name === "amber")!.palette;
    applyPalette(amber);
    expect(store["--surface"]).toBe(amber.bg);
    expect(store["--accent"]).toBe(amber.accent);
    expect(store["--surface"]).not.toBe(paper.bg);
  } finally {
    g.document = prev;
  }
});

test("applyPalette tolerates transient invalid hex (custom-editor live preview) and recovers", () => {
  const store: Record<string, string> = {};
  const root = { style: { setProperty: (k: string, v: string) => { store[k] = v; } } };
  const g = globalThis as any;
  const prev = g.document;
  g.document = { documentElement: root };
  try {
    const paper = BUILTIN_THEMES.find((t) => t.name === "paper")!.palette;
    // partial/invalid value mid-type must NOT throw (was a crash after the first C2 fix)
    expect(() => applyPalette({ ...paper, bg: "#12" } as any)).not.toThrow();
    expect(store["--bg"]).toBe("#12"); // legacy raw input still written (browser ignores invalid var)
    expect(isHexColor(store["--surface"])).toBe(true); // semantic derived from SANITIZED palette → valid
    expect(store["--surface"]).not.toBe("#12");
    // a subsequent VALID palette refreshes the semantic layer — no permanent stale state
    const amber = BUILTIN_THEMES.find((t) => t.name === "amber")!.palette;
    applyPalette(amber);
    expect(store["--surface"]).toBe(amber.bg);
    expect(store["--accent"]).toBe(amber.accent);
  } finally {
    g.document = prev;
  }
});
