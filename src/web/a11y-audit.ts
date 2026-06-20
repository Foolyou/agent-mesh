// Accessibility audit: prints the WCAG contrast ratio of every meaningful color
// pairing for each built-in theme and flags failures, then statically lints theme.css
// for unknown CSS-var references and hardcoded (un-themed) color literals.
// Run: bun run src/web/a11y-audit.ts  (alias: bun run a11y:palette)
//
// The pairing contract lives in client/contrast.ts (AUDIT_PAIRS) and is shared with
// the gate test (client/contrast.test.ts), so the human table and the CI assertion can
// never drift. "Meaningful pairing" = a (foreground role, background role) the CSS
// actually renders, grouped into semantic families each held to the right threshold:
// text / status-text / tinted-text / selection / syntax → AA 4.5; status-dot / focus /
// border → non-text 3.0; disabled → an advisory usability floor (reported, never fails).
// AAA (7:1) targets are reported as advisory only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_THEMES, THEME_KEYS, MODES, ACCENTS, compose, type Palette } from "./client/themes";
import { AUDIT_PAIRS, evalPair, fmtRatio, AAA_TEXT, V2_AUDIT_PAIRS, evalV2Pair, type Family } from "./client/contrast";

const FAMILY_ORDER: Family[] = [
  "text",
  "status-text",
  "tinted-text",
  "selection",
  "syntax",
  "status-dot",
  "focus",
  "border",
  "disabled",
];
const isTextFamily = (f: Family) => ["text", "status-text", "tinted-text", "selection", "syntax"].includes(f);

function auditTheme(name: string, p: Palette): { fails: number; advisories: string[] } {
  const rows = AUDIT_PAIRS.map((pair) => evalPair(pair, p)).sort(
    (a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family),
  );
  const fails = rows.filter((r) => !r.pass);
  console.log(`\n${"━".repeat(74)}\n  ${name.toUpperCase()}   ${fails.length ? `✗ ${fails.length} FAIL` : "✓ all pass"}`);
  let lastFamily = "";
  const advisories: string[] = [];
  for (const r of rows) {
    if (r.family !== lastFamily) {
      console.log(`  · ${r.family}`);
      lastFamily = r.family;
    }
    const mark = r.advisory ? "·" : r.pass ? "✓" : "✗";
    console.log(`   ${mark} ${String(fmtRatio(r.ratio)).padStart(6)}:1  (need ${r.need})  ${r.id}  — ${r.note}`);
    // AAA advisory for text pairs that pass AA but not AAA
    if (isTextFamily(r.family) && r.pass && r.ratio < AAA_TEXT)
      advisories.push(`${r.id} ${fmtRatio(r.ratio)}:1 (AAA wants ${AAA_TEXT})`);
  }
  return { fails: fails.length, advisories };
}

// ── static theme.css lint ─────────────────────────────────────────────────────
const NON_COLOR_VARS = new Set(["mono", "r", "pad", "mesh-vvh", "mesh-vvtop"]);
const KNOWN_VARS = new Set<string>([...THEME_KEYS, ...NON_COLOR_VARS]);

// Is an rgb/rgba/hsl literal effectively neutral (a shadow / scrim / white-or-black
// overlay)? Those legitimately bypass the palette; only CHROMATIC literals (a hardcoded
// status hue etc.) are worth surfacing. Achromatic = all channels within a small spread.
function isNeutralColorLiteral(lit: string): boolean {
  const rgb = lit.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const n = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (n.length >= 3 && n.slice(0, 3).every((x) => Number.isFinite(x))) {
      const [r, g, b] = n;
      return Math.max(r, g, b) - Math.min(r, g, b) <= 12; // grey-ish → neutral overlay
    }
    return false;
  }
  const hsl = lit.match(/hsla?\(([^)]+)\)/i);
  if (hsl) return parseFloat(hsl[1].split(/[,\s/]+/).filter(Boolean)[1] || "0") <= 5; // saturation %
  return false; // color(...) etc. — surface it
}

function lintThemeCss(): { unknownVars: string[]; literals: string[] } {
  const css = readFileSync(resolve(import.meta.dir, "client/theme.css"), "utf8");
  // 1. every var(--X) reference must name a known token (catches the old bare --accent bug).
  const unknownVars = new Set<string>();
  for (const m of css.matchAll(/var\(\s*--([a-z][a-z0-9-]*)/g)) if (!KNOWN_VARS.has(m[1])) unknownVars.add(m[1]);

  // 2. color literals outside the :root token block bypass theming. Strip :root (where
  //    tokens are legitimately defined), then flag any hardcoded hex AND any CHROMATIC
  //    rgb()/rgba()/hsl()/color() literal — neutral white/black/grey overlays (shadows,
  //    scrims, hover washes) are allowlisted so the advisory stays signal, not noise.
  //    Advisory only: a colored literal is a theming gap to review, not a build break.
  const body = css.replace(/:root\s*\{[\s\S]*?\}/, "");
  const literals = new Set<string>();
  for (const m of body.matchAll(/(^|[\s:,(])(#[0-9a-fA-F]{3,8})\b/g)) literals.add(m[2].toLowerCase());
  for (const m of body.matchAll(/\b(rgba?|hsla?|color)\([^)]*\)/gi)) {
    if (/^color-mix/i.test(m[0])) continue; // color-mix of tokens is themed, not a literal
    if (!isNeutralColorLiteral(m[0])) literals.add(m[0].replace(/\s+/g, " ").toLowerCase());
  }
  return { unknownVars: [...unknownVars].sort(), literals: [...literals].sort() };
}

let total = 0;
const allAdvisories: string[] = [];
for (const t of BUILTIN_THEMES) {
  const { fails, advisories } = auditTheme(t.label, t.palette);
  total += fails;
  if (advisories.length) allAdvisories.push(`${t.label}: ${advisories.length} AAA stretch pairs`);
}

// ── v2 token gate: all 9 mode × accent compositions ──────────────────────────
console.log(`\n${"━".repeat(74)}\n  v2 TOKENS — 9 mode×accent compositions (Dark·Slate / Light·Cool / Eye-care·Warm × Signal Teal / Ember / Fleet Azure)`);
let v2Total = 0;
const v2SoftMiss: string[] = [];
for (const mode of MODES) {
  for (const accent of ACCENTS) {
    const sp = compose(mode, accent);
    const rows = V2_AUDIT_PAIRS.map((p) => evalV2Pair(p, sp));
    const fails = rows.filter((r) => !r.pass);
    v2Total += fails.length;
    for (const r of rows) if (r.softPass === false && r.pass) v2SoftMiss.push(`${mode}×${accent} ${r.id} ${fmtRatio(r.ratio)}<${r.soft}`);
    console.log(
      `  ${fails.length ? "✗" : "✓"} ${mode} × ${accent}` +
        (fails.length ? ` — ${fails.length} FAIL: ${fails.map((f) => `${f.id} ${fmtRatio(f.ratio)}<${f.need}`).join(", ")}` : ` — all ${rows.length} pairs pass`),
    );
  }
}
if (v2SoftMiss.length) console.log(`  · soft-target (text-secondary ≥5.5) misses (report-only): ${v2SoftMiss.join(" | ")}`);
else console.log("  · text-secondary ≥5.5 soft target met in all 9 combinations");
total += v2Total;

console.log(`\n${"━".repeat(74)}\n  STATIC theme.css LINT`);
const { unknownVars, literals } = lintThemeCss();
if (unknownVars.length) {
  console.log(`   ✗ unknown var(--*) references (no such token): ${unknownVars.map((v) => `--${v}`).join(", ")}`);
  total += unknownVars.length;
} else {
  console.log("   ✓ every var(--*) reference resolves to a known token");
}
if (literals.length) {
  console.log(`   · ${literals.length} un-themed color literal(s) outside :root — hex + chromatic rgb/hsl/color() (advisory; neutral overlays allowlisted): ${literals.join(", ")}`);
} else {
  console.log("   ✓ no un-themed color literals outside the :root token block");
}

if (allAdvisories.length) {
  console.log(`\n  · AAA advisory (report-only): ${allAdvisories.join("; ")}`);
}

console.log(`\n${"━".repeat(74)}`);
if (total) {
  console.log(`  ✗ ${total} contrast/lint failures across ${BUILTIN_THEMES.length} themes`);
  process.exitCode = 1;
} else {
  console.log(`  ✓ all ${BUILTIN_THEMES.length} legacy themes + 9 v2 mode×accent compositions pass WCAG (v2 primary text AAA, focus/border-strong ≥4.5); theme.css clean`);
}
