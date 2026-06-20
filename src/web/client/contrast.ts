// WCAG 2.1 contrast math. A theme is just a palette of colors; accessibility is a
// property of (foreground, background) PAIRS, so this module computes the ratio for a
// pair and the audit/test assert the role pairings meet the right threshold.
//
// Thresholds (WCAG 2.1):
//   1.4.3 Contrast (AA)      — normal text ≥ 4.5:1, large text (≥18.66px, or ≥14px bold) ≥ 3:1
//   1.4.6 Contrast (AAA)     — normal text ≥ 7:1, large text ≥ 4.5:1
//   1.4.11 Non-text Contrast — UI components / graphical objects ≥ 3:1 against adjacent colors

export const AA_TEXT = 4.5;
export const AA_LARGE = 3.0;
export const AAA_TEXT = 7.0;
export const UI_COMPONENT = 3.0;

export type RGB = { r: number; g: number; b: number };

/** Parse #rgb / #rrggbb (with or without leading #) into 0-255 channels. */
export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) throw new Error(`bad hex color: "${hex}"`);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** Composite a translucent color over an opaque backdrop → the opaque color the eye sees. */
export function blend(fg: RGB, alpha: number, bg: RGB): RGB {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  };
}

/** WCAG relative luminance of an sRGB color (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two colors (hex strings or RGB), in [1, 21]. Order-independent. */
export function contrastRatio(a: string | RGB, b: string | RGB): number {
  const la = relativeLuminance(typeof a === "string" ? hexToRgb(a) : a);
  const lb = relativeLuminance(typeof b === "string" ? hexToRgb(b) : b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Round a ratio to 2dp for display (e.g. 4.53). */
export const fmtRatio = (r: number) => Math.round(r * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// Pair contract — THE single source of truth for "which (fg,bg) pairs the UI
// actually paints, and what WCAG threshold each must meet". Both the human audit
// (a11y-audit.ts) and the gate test (contrast.test.ts) import AUDIT_PAIRS +
// evalPair from here, so the two can never drift apart.
//
// A pair's colors are not always raw palette tokens: the CSS composites translucent
// status tints over a surface with color-mix(). color-mix(in srgb, A p%, B) in an
// opaque-or-transparent B both reduce to blend(A, p/100, B) (alpha compositing when
// B is "transparent" means blending over the surface it is painted on), so a single
// ColorSpec resolver covers tokens and tints alike.
// ─────────────────────────────────────────────────────────────────────────────

import type { Palette, ThemeVar, SemanticVar, SemanticPalette } from "./themes";

/** A color the CSS resolves to: a raw token, or a color-mix of a token over a base. */
export type ColorSpec =
  | ThemeVar
  | { mix: ThemeVar; pct: number; over: ThemeVar }; // color-mix(in srgb, <mix> <pct>%, <over|transparent-over-over>)

/** Semantic role families. Each maps to one WCAG threshold; `advisory` pairs are
 *  reported but never fail the gate (AAA targets, or the sub-AA disabled floor). */
export type Family =
  | "text" // body / secondary / faint text on a surface — AA 4.5
  | "status-text" // a status hue used as readable words (labels, counts) — AA 4.5
  | "status-dot" // a status hue used as a dot / left-border / badge edge — non-text 3.0
  | "selection" // text on the inverted selection / hover-fill surface — AA 4.5
  | "focus" // focus ring / outline against the surface it surrounds — non-text 3.0
  | "syntax" // code syntax-highlight token on the code (inset) surface — AA 4.5
  | "border" // control / divider border that must be perceivable — non-text 3.0
  | "tinted-text" // text sitting on a translucent status-tinted panel — AA 4.5
  | "disabled"; // disabled control text — HARD 3.0 usability floor (perceptible, not faded out)

export const FAMILY_THRESHOLD: Record<Family, number> = {
  text: AA_TEXT,
  "status-text": AA_TEXT,
  "status-dot": UI_COMPONENT,
  selection: AA_TEXT,
  focus: UI_COMPONENT,
  syntax: AA_TEXT,
  border: UI_COMPONENT,
  "tinted-text": AA_TEXT,
  disabled: UI_COMPONENT, // hard 3.0 usability floor: WCAG exempts disabled, but prdmgr requires perceptibility
};

export interface AuditPair {
  id: string;
  family: Family;
  fg: ColorSpec;
  bg: ColorSpec;
  note: string;
  /** Report-only: AAA stretch goals and the disabled floor never fail the gate. */
  advisory?: boolean;
}

/** Resolve a ColorSpec against a palette to a concrete RGB. */
export function resolveColor(spec: ColorSpec, p: Palette): RGB {
  if (typeof spec === "string") return hexToRgb(p[spec]);
  // color-mix(in srgb, mix pct%, over): blend mix over the resolved base at pct.
  return blend(hexToRgb(p[spec.mix]), spec.pct / 100, hexToRgb(p[spec.over]));
}

export interface PairResult extends AuditPair {
  ratio: number;
  need: number;
  pass: boolean;
}

/** Evaluate one pair against a palette. `pass` is always true for advisory pairs. */
export function evalPair(pair: AuditPair, p: Palette): PairResult {
  const ratio = contrastRatio(resolveColor(pair.fg, p), resolveColor(pair.bg, p));
  const need = FAMILY_THRESHOLD[pair.family];
  return { ...pair, ratio, need, pass: pair.advisory ? true : ratio >= need };
}

const SURFACES: ThemeVar[] = ["bg", "bg-raise", "bg-inset"];
const surfaceLabel: Record<string, string> = { bg: "base", "bg-raise": "raised", "bg-inset": "inset" };

/** Build the full pair contract for the role families the UI paints. Centralised
 *  here so audit + test enumerate exactly the same surface set. */
function buildPairs(): AuditPair[] {
  const pairs: AuditPair[] = [];

  // 1. Primary / secondary / tertiary text on every surface (AA 4.5).
  for (const fg of ["fg", "fg-dim", "fg-faint"] as ThemeVar[])
    for (const bg of SURFACES)
      pairs.push({ id: `text:${fg}/${bg}`, family: "text", fg, bg, note: `${fg} on ${surfaceLabel[bg]} surface` });

  // 2. Inverted selection / hover-fill surface carries text (AA 4.5).
  pairs.push({ id: "selection:sel", family: "selection", fg: "sel-fg", bg: "sel-bg", note: "text on selection / hover fill" });
  // faint text must also survive the subtle hover wash on the base surface.
  pairs.push({ id: "selection:hover-wash", family: "text", fg: "fg-dim", bg: { mix: "fg", pct: 3, over: "bg" }, note: "secondary text on .mrow:hover wash" });

  // 3. Status hues as READABLE TEXT (labels, counts, badges with words) — AA 4.5
  //    on every surface they actually render words on, plus the translucent tinted
  //    panels they sit on (.queue-source, .compose-interrupt, harness/health badges).
  for (const role of ["ok", "warn", "bad", "info"] as ThemeVar[])
    for (const bg of SURFACES)
      pairs.push({ id: `status-text:${role}/${bg}`, family: "status-text", fg: role, bg, note: `${role} as text on ${surfaceLabel[bg]} surface` });
  // Status text on its OWN translucent tint — only the hues the CSS actually paints
  // same-color text onto: .compose-interrupt / `.bad` panels (bad ≤12% over inset) and
  // the limit/queue warn panels (warn ≤10%). ok/info tints carry fg / fg-dim text, not
  // their own hue, so they are covered by the status-text rows above, not here.
  pairs.push({ id: "tinted-text:bad", family: "tinted-text", fg: "bad", bg: { mix: "bad", pct: 12, over: "bg-inset" }, note: "bad text on its ~12% tinted panel (.compose-interrupt)" });
  pairs.push({ id: "tinted-text:warn", family: "tinted-text", fg: "warn", bg: { mix: "warn", pct: 10, over: "bg-inset" }, note: "warn text on its ~10% tinted panel (limit / queue)" });

  // 3b. Hyperlink text (.feishu-link, future links) reads as words on every surface it
  //     can render on — AA 4.5. `link` is its own first-class token (defaults to info),
  //     so a theme that picks a low-contrast link colour is caught by the gate.
  for (const bg of SURFACES)
    pairs.push({ id: `status-text:link/${bg}`, family: "status-text", fg: "link", bg, note: `link text on ${surfaceLabel[bg]} surface` });

  // 4. Status hues as DOTS / LEFT-BORDERS / BADGE EDGES — non-text 3.0 on base.
  for (const role of ["ok", "warn", "bad", "info", "off"] as ThemeVar[])
    pairs.push({ id: `status-dot:${role}`, family: "status-dot", fg: role, bg: "bg", note: `${role} status dot / border on base` });

  // 5. Syntax highlight tokens render on the code (inset) surface — AA 4.5.
  //    info=keyword, good=string, fg-faint=comment, bad/warn used by other tokens.
  for (const role of ["info", "good", "bad", "warn"] as ThemeVar[])
    pairs.push({ id: `syntax:${role}`, family: "syntax", fg: role, bg: "bg-inset", note: `${role} syntax token on code surface` });

  // 6. Focus ring must be perceivable against the surfaces it can surround — 3.0.
  for (const bg of SURFACES)
    pairs.push({ id: `focus:${bg}`, family: "focus", fg: "focus", bg, note: `focus ring on ${surfaceLabel[bg]} surface` });

  // 7. The "thinking / compacting" accent: text + edge on base and raised — AA / 3.0.
  pairs.push({ id: "status-text:accent/bg", family: "status-text", fg: "accent", bg: "bg", note: "accent (compacting) label on base" });
  pairs.push({ id: "status-text:accent/bg-raise", family: "status-text", fg: "accent", bg: "bg-raise", note: "accent (compacting) label on raised" });

  // 8. Control / divider borders perceivable on base + raised surfaces — 3.0.
  for (const bg of ["bg", "bg-raise"] as ThemeVar[])
    pairs.push({ id: `border:line-bright/${bg}`, family: "border", fg: "line-bright", bg, note: `control border on ${surfaceLabel[bg]} surface` });

  // 9. Disabled controls — a HARD 3.0 usability floor (prdmgr requirement; WCAG 1.4.3
  //    technically exempts disabled controls). Disabled text uses the muted --fg-faint
  //    role, NOT an opacity fade: opacity collapses dark-on-light text below 3.0 on light
  //    themes (~1.8:1 at 0.35), so theme.css disables via explicit fg-faint + dimmed
  //    border + not-allowed cursor instead. Gated on every surface a control can sit on.
  for (const bg of SURFACES)
    pairs.push({ id: `disabled:${bg}`, family: "disabled", fg: "fg-faint", bg, note: `disabled control label on ${surfaceLabel[bg]} surface` });

  return pairs;
}

export const AUDIT_PAIRS: AuditPair[] = buildPairs();

// ════════════════════════════════════════════════════════════════════════════
// v2 contrast contract (Step 5 C3) — gates the two-layer semantic token model
// across all 9 mode×accent compositions (themes.ts `compose()`). COEXISTS with
// the v1 contract above (which still gates the 8 legacy BUILTIN_THEMES during the
// migration). A composed SemanticPalette already resolves `*-subtle` / `on-*` to
// concrete tokens, so v2 pairs are direct (fg token vs bg token) — no ColorSpec /
// color-mix. Source of truth: docs/design/ui/tokens/02-aa-evidence.md.
// ════════════════════════════════════════════════════════════════════════════

/** Stronger-than-AA non-text threshold (focus ring + interactive control border). */
export const UI_STRONG = 4.5;

export type V2Family =
  | "text-aaa" // primary body text — AAA 7.0
  | "text" // secondary / muted text — AA 4.5 (secondary also carries a soft 5.5 target)
  | "disabled" // disabled text — 3.0 floor
  | "status-text" // status / link / accent hue as readable words — AA 4.5
  | "status-dot" // status hue as dot / edge — non-text 3.0
  | "tinted-text" // text on a *-subtle / accent-subtle tint — AA 4.5
  | "syntax" // syntax token on the code surface — AA 4.5
  | "focus" // focus ring — UI_STRONG 4.5
  | "border-strong" // interactive control edge — UI_STRONG 4.5
  | "on-fill" // foreground on a filled status / accent surface — AA 4.5
  | "selection" // text on the selected fill — AA 4.5
  | "border" // hairline divider — report-only
  | "surface-step"; // surface elevation separation — report-only

export const V2_FAMILY_THRESHOLD: Record<V2Family, number> = {
  "text-aaa": AAA_TEXT,
  text: AA_TEXT,
  disabled: UI_COMPONENT,
  "status-text": AA_TEXT,
  "status-dot": UI_COMPONENT,
  "tinted-text": AA_TEXT,
  syntax: AA_TEXT,
  focus: UI_STRONG,
  "border-strong": UI_STRONG,
  "on-fill": AA_TEXT,
  selection: AA_TEXT,
  border: UI_COMPONENT, // advisory (report-only)
  "surface-step": 1.2, // advisory (report-only) house target
};

export interface V2Pair {
  id: string;
  family: V2Family;
  fg: SemanticVar;
  bg: SemanticVar;
  /** report-only: reported, never fails the gate (hairline border, surface-step). */
  advisory?: boolean;
  /** soft target (reported, never fails) — e.g. text-secondary ≥5.5. */
  soft?: number;
}
export interface V2PairResult extends V2Pair {
  ratio: number;
  need: number;
  pass: boolean;
  softPass?: boolean;
}

/** Evaluate one v2 pair against a composed semantic palette. `pass` is always
 *  true for advisory pairs; `softPass` reports the soft target without gating. */
export function evalV2Pair(pair: V2Pair, p: SemanticPalette): V2PairResult {
  const ratio = contrastRatio(hexToRgb(p[pair.fg]), hexToRgb(p[pair.bg]));
  const need = V2_FAMILY_THRESHOLD[pair.family];
  return {
    ...pair,
    ratio,
    need,
    pass: pair.advisory ? true : ratio >= need,
    softPass: pair.soft === undefined ? undefined : ratio >= pair.soft,
  };
}

const V2_SURFACES: SemanticVar[] = ["surface", "surface-raised", "surface-sunken"];

/** The v2 pair contract — what compose(mode,accent) must satisfy. Shared by the
 *  audit (a11y-audit.ts) and the gate test (contrast-v2.test.ts). */
function buildV2Pairs(): V2Pair[] {
  const pairs: V2Pair[] = [];
  // 1. Text hierarchy: primary → AAA, secondary (soft 5.5) + muted → AA, disabled → 3.0.
  for (const bg of V2_SURFACES) pairs.push({ id: `text-primary/${bg}`, family: "text-aaa", fg: "text-primary", bg });
  for (const bg of V2_SURFACES) pairs.push({ id: `text-secondary/${bg}`, family: "text", fg: "text-secondary", bg, soft: 5.5 });
  for (const bg of V2_SURFACES) pairs.push({ id: `text-muted/${bg}`, family: "text", fg: "text-muted", bg });
  for (const bg of V2_SURFACES) pairs.push({ id: `text-disabled/${bg}`, family: "disabled", fg: "text-disabled", bg });
  // 2. Status / link / idle / accent as readable text on surface + raised — AA.
  const textHues: SemanticVar[] = ["success", "warning", "danger", "info", "link", "idle", "accent"];
  for (const role of textHues)
    for (const bg of ["surface", "surface-raised"] as SemanticVar[])
      pairs.push({ id: `text:${role}/${bg}`, family: "status-text", fg: role, bg });
  // 3. Status text on its own *-subtle tint + text on the accent-subtle tint — AA.
  pairs.push({ id: "tinted:success", family: "tinted-text", fg: "success", bg: "success-subtle" });
  pairs.push({ id: "tinted:warning", family: "tinted-text", fg: "warning", bg: "warning-subtle" });
  pairs.push({ id: "tinted:danger", family: "tinted-text", fg: "danger", bg: "danger-subtle" });
  pairs.push({ id: "tinted:info", family: "tinted-text", fg: "info", bg: "info-subtle" });
  pairs.push({ id: "tinted:accent-subtle", family: "tinted-text", fg: "text-primary", bg: "accent-subtle" });
  // 4. Status / accent as dots / edges (non-text) on base.
  for (const role of ["success", "warning", "danger", "info", "idle"] as SemanticVar[])
    pairs.push({ id: `dot:${role}`, family: "status-dot", fg: role, bg: "surface" });
  // 5. on-* foreground over the filled status / accent surfaces — AA.
  pairs.push({ id: "on-success", family: "on-fill", fg: "on-success", bg: "success" });
  pairs.push({ id: "on-warning", family: "on-fill", fg: "on-warning", bg: "warning" });
  pairs.push({ id: "on-danger", family: "on-fill", fg: "on-danger", bg: "danger" });
  pairs.push({ id: "on-info", family: "on-fill", fg: "on-info", bg: "info" });
  pairs.push({ id: "on-accent", family: "on-fill", fg: "on-accent", bg: "accent" });
  // 6. Syntax tokens on the code (sunken) surface — AA.
  for (const k of ["syntax-keyword", "syntax-string", "syntax-comment"] as SemanticVar[])
    pairs.push({ id: k, family: "syntax", fg: k, bg: "surface-sunken" });
  // 7. Focus ring (UI_STRONG) on every surface.
  for (const bg of V2_SURFACES) pairs.push({ id: `focus/${bg}`, family: "focus", fg: "focus-ring", bg });
  // 8. Strong interactive border (UI_STRONG) on surface + raised.
  for (const bg of ["surface", "surface-raised"] as SemanticVar[])
    pairs.push({ id: `border-strong/${bg}`, family: "border-strong", fg: "border-strong", bg });
  // 9. Selected fill carries text — AA.
  pairs.push({ id: "selection", family: "selection", fg: "text-on-selected", bg: "selected" });
  // 10. report-only: hairline divider + surface elevation steps.
  for (const bg of ["surface", "surface-raised"] as SemanticVar[])
    pairs.push({ id: `border/${bg}`, family: "border", fg: "border", bg, advisory: true });
  pairs.push({ id: "surface-step:raised", family: "surface-step", fg: "surface-raised", bg: "surface", advisory: true });
  pairs.push({ id: "surface-step:sunken", family: "surface-step", fg: "surface-sunken", bg: "surface", advisory: true });
  return pairs;
}

export const V2_AUDIT_PAIRS: V2Pair[] = buildV2Pairs();
