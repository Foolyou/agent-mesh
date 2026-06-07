// Enforces the WCAG contrast contract for every built-in theme. If someone tweaks a
// palette color and drops a role pairing below threshold, this fails. The thresholds
// mirror src/web/a11y-audit.ts (which prints the full table for humans).
import { test, expect } from "bun:test";
import { BUILTIN_THEMES } from "./themes";
import { contrastRatio, hexToRgb, blend, AA_TEXT, UI_COMPONENT } from "./contrast";

const SURFACES = ["bg", "bg-raise", "bg-inset"] as const;
const TEXT_ROLES = ["fg", "fg-dim", "fg-faint"] as const;
const STATUS_ROLES = ["ok", "warn", "bad", "info", "off"] as const;

for (const theme of BUILTIN_THEMES) {
  const p = theme.palette;

  test(`${theme.name}: every text role meets AA (4.5:1) on every surface`, () => {
    for (const role of TEXT_ROLES) {
      for (const surf of SURFACES) {
        const r = contrastRatio(p[role], p[surf]);
        expect(r, `${role} on ${surf} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  test(`${theme.name}: text on the inverted selection surface meets AA`, () => {
    const r = contrastRatio(p["sel-fg"], p["sel-bg"]);
    expect(r, `sel-fg on sel-bg = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test(`${theme.name}: status indicators + control borders meet non-text 3:1`, () => {
    for (const role of STATUS_ROLES) {
      const r = contrastRatio(p[role], p["bg"]);
      expect(r, `${role} on bg = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(UI_COMPONENT);
    }
    // control/divider border must be perceivable on the darkest AND the raised surface
    for (const surf of ["bg", "bg-raise"] as const) {
      const r = contrastRatio(p["line-bright"], p[surf]);
      expect(r, `line-bright on ${surf} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(UI_COMPONENT);
    }
  });

  test(`${theme.name}: the subtle hover wash keeps fg-dim readable`, () => {
    // .mrow:hover paints rgba(255,255,255,0.03) over bg; secondary text must survive it.
    const washed = blend({ r: 255, g: 255, b: 255 }, 0.03, hexToRgb(p["bg"]));
    const r = contrastRatio(hexToRgb(p["fg-dim"]), washed);
    expect(r, `fg-dim on hover-wash = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
  });
}
