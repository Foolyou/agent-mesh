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
import { BUILTIN_THEMES, THEME_KEYS, type Palette } from "./client/themes";
import { AUDIT_PAIRS, evalPair, fmtRatio, AAA_TEXT, type Family } from "./client/contrast";

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
const NON_COLOR_VARS = new Set(["mono", "r", "pad", "mesh-vvh"]);
const KNOWN_VARS = new Set<string>([...THEME_KEYS, ...NON_COLOR_VARS]);

function lintThemeCss(): { unknownVars: string[]; hardcoded: string[] } {
  const css = readFileSync(resolve(import.meta.dir, "client/theme.css"), "utf8");
  // 1. every var(--X) reference must name a known token (catches the old bare --accent bug).
  const unknownVars = new Set<string>();
  for (const m of css.matchAll(/var\(\s*--([a-z][a-z0-9-]*)/g)) if (!KNOWN_VARS.has(m[1])) unknownVars.add(m[1]);

  // 2. hardcoded hex color literals outside the :root token block are un-themeable and
  //    bypass the palette → flag for review. Strip the :root block (where tokens are
  //    legitimately defined) first, then scan declarations.
  const body = css.replace(/:root\s*\{[\s\S]*?\}/, "");
  const hardcoded = new Set<string>();
  for (const m of body.matchAll(/(^|[\s:,(])(#[0-9a-fA-F]{3,8})\b/g)) hardcoded.add(m[2].toLowerCase());
  return { unknownVars: [...unknownVars].sort(), hardcoded: [...hardcoded].sort() };
}

let total = 0;
const allAdvisories: string[] = [];
for (const t of BUILTIN_THEMES) {
  const { fails, advisories } = auditTheme(t.label, t.palette);
  total += fails;
  if (advisories.length) allAdvisories.push(`${t.label}: ${advisories.length} AAA stretch pairs`);
}

console.log(`\n${"━".repeat(74)}\n  STATIC theme.css LINT`);
const { unknownVars, hardcoded } = lintThemeCss();
if (unknownVars.length) {
  console.log(`   ✗ unknown var(--*) references (no such token): ${unknownVars.map((v) => `--${v}`).join(", ")}`);
  total += unknownVars.length;
} else {
  console.log("   ✓ every var(--*) reference resolves to a known token");
}
if (hardcoded.length) {
  console.log(`   · ${hardcoded.length} hardcoded color literal(s) outside :root (advisory — review for theming): ${hardcoded.join(", ")}`);
} else {
  console.log("   ✓ no hardcoded color literals outside the :root token block");
}

if (allAdvisories.length) {
  console.log(`\n  · AAA advisory (report-only): ${allAdvisories.join("; ")}`);
}

console.log(`\n${"━".repeat(74)}`);
if (total) {
  console.log(`  ✗ ${total} contrast/lint failures across ${BUILTIN_THEMES.length} themes`);
  process.exitCode = 1;
} else {
  console.log(`  ✓ all ${BUILTIN_THEMES.length} themes pass WCAG AA (text) + non-text (UI) contrast; theme.css clean`);
}
