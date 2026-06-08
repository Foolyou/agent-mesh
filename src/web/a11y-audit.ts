// Accessibility audit: prints the WCAG contrast ratio of every meaningful color
// pairing for each built-in theme and flags failures. Run: bun run src/web/a11y-audit.ts
//
// "Meaningful pairing" = a (foreground role, background role) that the CSS actually
// renders. Text pairings are held to AA (4.5:1); graphical/UI pairings (status dots,
// control borders) to non-text contrast (3:1). The inverted selection surface
// (sel-bg) is audited too, since that's where the start-button bug lived.
import { BUILTIN_THEMES, type Palette, type ThemeVar } from "./client/themes";
import { contrastRatio, fmtRatio, AA_TEXT, UI_COMPONENT } from "./client/contrast";

type Kind = "text" | "ui";
interface Pair {
  fg: ThemeVar;
  bg: ThemeVar;
  kind: Kind;
  note: string;
}

// The pairings the UI actually paints, by token role.
const PAIRS: Pair[] = [
  // primary text on every surface
  { fg: "fg", bg: "bg", kind: "text", note: "primary text" },
  { fg: "fg", bg: "bg-raise", kind: "text", note: "primary text / raised panel" },
  { fg: "fg", bg: "bg-inset", kind: "text", note: "primary text / inset (code, inputs)" },
  // secondary text (panel heads, buttons, mesh rows, agent labels) on every surface
  { fg: "fg-dim", bg: "bg", kind: "text", note: "secondary text / buttons" },
  { fg: "fg-dim", bg: "bg-raise", kind: "text", note: "secondary text / raised" },
  { fg: "fg-dim", bg: "bg-inset", kind: "text", note: "secondary text / inset" },
  // faint text (timestamps, hints, placeholders) — must still be readable
  { fg: "fg-faint", bg: "bg", kind: "text", note: "faint text / hints" },
  { fg: "fg-faint", bg: "bg-raise", kind: "text", note: "faint text / raised" },
  { fg: "fg-faint", bg: "bg-inset", kind: "text", note: "faint text / inset" },
  // inverted selection surface (mesh-row selection, ::selection, button :hover)
  { fg: "sel-fg", bg: "sel-bg", kind: "text", note: "text on selection / hover fill" },
  // status colors as small text/badges → treat as text where they carry words
  { fg: "ok", bg: "bg", kind: "ui", note: "ok status (dot/label)" },
  { fg: "warn", bg: "bg", kind: "ui", note: "warn status" },
  { fg: "bad", bg: "bg", kind: "ui", note: "bad status" },
  { fg: "info", bg: "bg", kind: "ui", note: "info / mail accent" },
  { fg: "info", bg: "bg-raise", kind: "text", note: "info links / canvas active edge near raised surfaces" },
  { fg: "info", bg: "bg-inset", kind: "text", note: "info links / canvas active edge near inset surfaces" },
  { fg: "off", bg: "bg", kind: "ui", note: "off / dead dot" },
  // control + divider borders must be perceivable
  { fg: "line-bright", bg: "bg", kind: "ui", note: "control border (buttons)" },
  { fg: "line-bright", bg: "bg-raise", kind: "ui", note: "control border / raised" },
];

const threshold = (k: Kind) => (k === "text" ? AA_TEXT : UI_COMPONENT);

function auditTheme(name: string, p: Palette) {
  const rows = PAIRS.map((pair) => {
    const ratio = contrastRatio(p[pair.fg], p[pair.bg]);
    const need = threshold(pair.kind);
    return { ...pair, ratio, need, pass: ratio >= need };
  });
  const fails = rows.filter((r) => !r.pass);
  console.log(`\n${"━".repeat(72)}\n  ${name.toUpperCase()}   ${fails.length ? `✗ ${fails.length} FAIL` : "✓ all pass"}`);
  for (const r of rows) {
    const mark = r.pass ? "✓" : "✗";
    const lvl = r.kind === "text" ? "AA" : "UI";
    console.log(
      `   ${mark} ${String(fmtRatio(r.ratio)).padStart(6)}:1  (need ${r.need} ${lvl})  ${r.fg} on ${r.bg}  — ${r.note}`,
    );
  }
  return fails.length;
}

let total = 0;
for (const t of BUILTIN_THEMES) total += auditTheme(t.label, t.palette);
console.log(`\n${"━".repeat(72)}`);
if (total) {
  console.log(`  ✗ ${total} contrast failures across ${BUILTIN_THEMES.length} themes`);
  process.exitCode = 1;
} else {
  console.log(`  ✓ all ${BUILTIN_THEMES.length} themes pass WCAG AA (text) + non-text (UI) contrast`);
}
