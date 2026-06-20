// Raw-token lint guard (Step 5 C4).
//
// The v2 token system is two-layer: components must use SEMANTIC utilities
// (bg-surface, text-text-primary, text-success, bg-accent, …), never the RAW
// 11-stop scales (raw-slate-500, raw-signal-teal-400, …). Raw scales are the
// palette's private substrate (themes.ts RAW); referencing them in component code
// hard-codes a non-theme-reactive value and defeats mode/accent switching.
//
// This guard scans source for raw-* references and FAILS on any hit, unless the
// line carries an explicit, REASONED opt-out: `raw-token-allow: <reason>`.
// Run: bun run src/web/raw-token-guard.ts   (alias: bun run lint:tokens)

export const RAW_RAMPS = [
  "slate", "cool", "warm", "green", "amber", "red", "blue", "gray",
  "signal-teal", "ember", "fleet-azure",
] as const;

// Matches a raw-scale token reference in any form the codebase could produce:
//   utility class:  bg-raw-slate-500 / text-raw-ember-400 / border-raw-blue-700
//   bare token:     raw-signal-teal-400
//   CSS var:        --raw-cool-600 / var(--color-raw-warm-200)
// (\b before "raw" matches after "-" in "bg-raw-…" and "--…-raw-…" too.)
export const RAW_TOKEN_RE = new RegExp(`\\braw-(?:${RAW_RAMPS.join("|")})-\\d{2,3}\\b`, "g");

// An explicit, reasoned opt-out on the same line suppresses the violation.
// `raw-token-allow:` MUST be followed by a non-empty reason.
const ALLOW_RE = /raw-token-allow:\s*\S/;

export interface RawViolation {
  line: number;
  text: string;
  match: string;
}

/** Scan one source string for raw-token violations (per line, honoring the
 *  reasoned opt-out). Returns [] for clean / semantic-only / properly-disabled code. */
export function scanRawTokens(source: string): RawViolation[] {
  const out: RawViolation[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    RAW_TOKEN_RE.lastIndex = 0;
    const m = RAW_TOKEN_RE.exec(ln);
    if (!m) continue;
    if (ALLOW_RE.test(ln)) continue; // explicit reasoned opt-out
    out.push({ line: i + 1, text: ln.trim().slice(0, 120), match: m[0] });
  }
  return out;
}

// Files that legitimately reference raw-* and are exempt from the project scan:
//   - the guard + its test (define the pattern / synthetic fixtures)
//   - themes.ts (defines the RAW scales themselves — values, not raw-* utilities)
//   - tailwind.css (would hold any raw @theme exposure, if added later)
const EXEMPT = new Set([
  "src/web/raw-token-guard.ts",
  "src/web/raw-token-guard.test.ts",
  "src/web/client/themes.ts",
  "src/web/client/tailwind.css",
]);

export interface ProjectViolation extends RawViolation {
  file: string;
}

/** Scan the web source tree for raw-token usage in component/source code. */
export async function scanProject(root = "src/web"): Promise<ProjectViolation[]> {
  const glob = new Bun.Glob("**/*.{ts,tsx,css}");
  const out: ProjectViolation[] = [];
  for await (const rel of glob.scan({ cwd: root })) {
    const file = `${root}/${rel}`;
    if (EXEMPT.has(file)) continue;
    const src = await Bun.file(file).text();
    for (const v of scanRawTokens(src)) out.push({ file, ...v });
  }
  return out;
}

// CLI entry: print violations and exit non-zero if any.
if (import.meta.main) {
  const violations = await scanProject();
  if (violations.length) {
    console.error(`✗ raw-token guard: ${violations.length} forbidden raw-* reference(s) — use semantic utilities (or add 'raw-token-allow: <reason>' on the line to opt out):`);
    for (const v of violations) console.error(`   ${v.file}:${v.line}  ${v.match}  — ${v.text}`);
    process.exit(1);
  }
  console.log("✓ raw-token guard: no forbidden raw-* references in src/web (components use semantic utilities)");
}
