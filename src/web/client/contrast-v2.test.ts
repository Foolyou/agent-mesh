import { test, expect } from "bun:test";
import { MODES, ACCENTS, compose } from "./themes";
import { V2_AUDIT_PAIRS, evalV2Pair, AAA_TEXT, UI_STRONG } from "./contrast";

// C3 gate: the v2 token contract must hold for ALL 9 mode×accent compositions.

test("V2_AUDIT_PAIRS covers the v2 contract (non-empty, has AAA + report-only families)", () => {
  expect(V2_AUDIT_PAIRS.length).toBeGreaterThan(30);
  expect(V2_AUDIT_PAIRS.some((p) => p.family === "text-aaa")).toBe(true);
  expect(V2_AUDIT_PAIRS.some((p) => p.family === "on-fill")).toBe(true);
  expect(V2_AUDIT_PAIRS.some((p) => p.family === "surface-step" && p.advisory)).toBe(true);
  expect(UI_STRONG).toBe(4.5);
});

test("every non-advisory v2 pair passes in all 9 mode×accent combinations", () => {
  const failures: string[] = [];
  for (const mode of MODES) {
    for (const accent of ACCENTS) {
      const sp = compose(mode, accent);
      for (const pair of V2_AUDIT_PAIRS) {
        const r = evalV2Pair(pair, sp);
        if (!r.pass) failures.push(`${mode}×${accent} ${r.id} ${r.ratio.toFixed(2)}<${r.need}`);
      }
    }
  }
  expect(failures).toEqual([]);
});

test("text-primary clears AAA 7.0 on every surface in all 9 combinations", () => {
  for (const mode of MODES) {
    for (const accent of ACCENTS) {
      const sp = compose(mode, accent);
      for (const r of V2_AUDIT_PAIRS.filter((p) => p.family === "text-aaa").map((p) => evalV2Pair(p, sp))) {
        expect(r.need).toBe(AAA_TEXT);
        expect(r.ratio).toBeGreaterThanOrEqual(AAA_TEXT);
      }
    }
  }
});

test("text-secondary meets the ≥5.5 soft target in all 9 combinations", () => {
  for (const mode of MODES) {
    for (const accent of ACCENTS) {
      const sp = compose(mode, accent);
      for (const r of V2_AUDIT_PAIRS.filter((p) => p.id.startsWith("text-secondary/")).map((p) => evalV2Pair(p, sp))) {
        expect(r.softPass).toBe(true);
      }
    }
  }
});

test("focus-ring and border-strong are gated at the stronger ≥4.5 (not the 3.0 floor)", () => {
  const sp = compose("light-cool", "signal-teal");
  for (const r of V2_AUDIT_PAIRS.filter((p) => p.family === "focus" || p.family === "border-strong").map((p) => evalV2Pair(p, sp))) {
    expect(r.need).toBe(UI_STRONG);
    expect(r.pass).toBe(true);
  }
});

test("on-* + accent + *-subtle pairs clear AA 4.5 (incl. Dark amber on-warning = near-black)", () => {
  // representative: bright Dark fills take near-black on-*, dark Light fills take white
  for (const [mode, accent] of [["dark-slate", "ember"], ["light-cool", "ember"], ["eye-care-warm", "signal-teal"]] as const) {
    const sp = compose(mode, accent);
    for (const r of V2_AUDIT_PAIRS.filter((p) => p.family === "on-fill" || p.family === "tinted-text").map((p) => evalV2Pair(p, sp))) {
      expect(r.ratio).toBeGreaterThanOrEqual(4.5);
    }
  }
});
