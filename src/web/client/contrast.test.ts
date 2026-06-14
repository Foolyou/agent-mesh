// Enforces the WCAG contrast contract for every built-in theme. The pairing contract
// (which fg/bg pairs the UI paints + the threshold each must meet) lives in contrast.ts
// as AUDIT_PAIRS and is shared with the human audit (src/web/a11y-audit.ts), so the gate
// and the printed table can never drift. AA (4.5 text / 3.0 non-text) is the hard gate;
// AAA (7:1) is advisory only and never fails here.
import { test, expect } from "bun:test";
import { BUILTIN_THEMES, THEME_KEYS } from "./themes";
import { AUDIT_PAIRS, evalPair, FAMILY_THRESHOLD, contrastRatio, AAA_TEXT, type Family } from "./contrast";

const GATED_FAMILIES: Family[] = Object.keys(FAMILY_THRESHOLD) as Family[];

for (const theme of BUILTIN_THEMES) {
  const p = theme.palette;

  // Every non-advisory pair in the contract must meet its family threshold. One test
  // per theme reports the first offender with its id + measured ratio.
  test(`${theme.name}: all audited pairs meet their WCAG threshold`, () => {
    for (const pair of AUDIT_PAIRS) {
      if (pair.advisory) continue;
      const r = evalPair(pair, p);
      expect(r.pass, `${pair.id} = ${r.ratio.toFixed(2)}:1 (need ${r.need}, ${pair.family})`).toBe(true);
    }
  });
}

// The contract must actually exercise every gated family on a representative theme, so a
// future refactor can't silently drop a whole role family from coverage.
test("contract covers every gated role family", () => {
  const covered = new Set(AUDIT_PAIRS.map((pr) => pr.family));
  for (const fam of GATED_FAMILIES) expect(covered.has(fam), `family "${fam}" has no audited pairs`).toBe(true);
});

// The new first-class tokens (good/accent/focus) must be part of every palette so the
// audit can reach them — guards against re-introducing a bare, unthemed var(--accent).
test("good/accent/focus are first-class palette tokens", () => {
  for (const k of ["good", "accent", "focus"] as const) expect(THEME_KEYS).toContain(k);
  for (const theme of BUILTIN_THEMES)
    for (const k of ["good", "accent", "focus"] as const)
      expect((theme.palette as any)[k], `${theme.name}.${k}`).toMatch(/^#[0-9a-fA-F]{6}$/);
});

// AAA is advisory: we don't fail on it, but we DO assert primary body text clears AAA on
// every surface in every theme — that's a deliberate quality bar, not a stretch goal.
test("primary text (fg) clears AAA on every surface in every theme", () => {
  for (const theme of BUILTIN_THEMES)
    for (const surf of ["bg", "bg-raise", "bg-inset"] as const) {
      const r = contrastRatio(theme.palette.fg, theme.palette[surf]);
      expect(r, `${theme.name}: fg on ${surf} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(AAA_TEXT);
    }
});
