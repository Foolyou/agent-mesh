import { blend, hexToRgb, contrastRatio } from "./contrast";

// Theme system. Everything visual runs on CSS custom properties, so a "theme" is
// just a palette of values for those properties. Built-in presets + a user custom
// palette are applied by setting the vars on :root; the choice persists in
// localStorage and is applied on load (index.tsx) before first paint.

export const THEME_KEYS = [
  "bg",
  "bg-raise",
  "bg-inset",
  "line",
  "line-bright",
  "fg",
  "fg-dim",
  "fg-faint",
  "ok",
  "warn",
  "bad",
  "off",
  "info",
  "link",
  "good",
  "accent",
  "focus",
  "sel-bg",
  "sel-fg",
] as const;
export type ThemeVar = (typeof THEME_KEYS)[number];
export type Palette = Record<ThemeVar, string>;

export interface Theme {
  name: string;
  label: string;
  palette: Palette;
}

// Each preset is a full palette whose role pairings meet WCAG: all text roles
// (fg / fg-dim / fg-faint) ≥ 4.5:1 (AA) on every surface, status indicators and
// control borders ≥ 3:1 (non-text). Enforced by contrast.test.ts + a11y-audit.ts —
// edit a color and run `bun run src/web/a11y-audit.ts` to re-check.
export const BUILTIN_THEMES: Theme[] = [
  {
    name: "phosphor",
    label: "Phosphor",
    palette: {
      bg: "#0a0b0d",
      "bg-raise": "#101216",
      "bg-inset": "#07080a",
      line: "#1c1f24",
      "line-bright": "#5f656e",
      fg: "#e8eae5",
      "fg-dim": "#c2c8cf",
      "fg-faint": "#99a0a8",
      ok: "#4ec97a",
      warn: "#e2b341",
      bad: "#f0584b",
      off: "#5a6068",
      info: "#5ac8e0",
      link: "#5ac8e0",
      good: "#6cd39a",
      accent: "#b9a3f0",
      focus: "#5ac8e0",
      "sel-bg": "#e4e6e1",
      "sel-fg": "#0a0b0d",
    },
  },
  {
    name: "amber",
    label: "Amber CRT",
    palette: {
      bg: "#100a04",
      "bg-raise": "#1a1209",
      "bg-inset": "#0a0602",
      line: "#2e2110",
      "line-bright": "#7a5d33",
      fg: "#f6cf94",
      "fg-dim": "#e2bf82",
      "fg-faint": "#b8945c",
      ok: "#a7cf4f",
      warn: "#ffb02e",
      bad: "#ff5e46",
      off: "#7a6238",
      info: "#e8a13a",
      link: "#e8a13a",
      good: "#bcd16a",
      accent: "#e0b0ff",
      focus: "#ffb02e",
      "sel-bg": "#ffb02e",
      "sel-fg": "#100a04",
    },
  },
  {
    name: "ice",
    label: "Ice",
    palette: {
      bg: "#080b10",
      "bg-raise": "#0e131b",
      "bg-inset": "#05080c",
      line: "#182230",
      "line-bright": "#506a80",
      fg: "#e2ebf3",
      "fg-dim": "#bccddd",
      "fg-faint": "#90a3b8",
      ok: "#4ec9b0",
      warn: "#e2b341",
      bad: "#f0586b",
      off: "#5a6878",
      info: "#5aa8e0",
      link: "#5aa8e0",
      good: "#5fd0b0",
      accent: "#b6a8f2",
      focus: "#5aa8e0",
      "sel-bg": "#cfe3f5",
      "sel-fg": "#080b10",
    },
  },
  {
    name: "paper",
    label: "Paper (light)",
    palette: {
      bg: "#f4f2ec",
      "bg-raise": "#ffffff",
      "bg-inset": "#ece9e1",
      line: "#d9d6cc",
      "line-bright": "#8a8780",
      fg: "#16150f",
      "fg-dim": "#403e38",
      "fg-faint": "#5e5c55",
      ok: "#0c7034",
      warn: "#7e5600",
      bad: "#ad281c",
      off: "#84817a",
      info: "#005c84",
      link: "#005c84",
      good: "#137040",
      accent: "#6a34a0",
      focus: "#005c84",
      "sel-bg": "#1c1b18",
      "sel-fg": "#f4f2ec",
    },
  },
  {
    name: "mono",
    label: "Mono",
    palette: {
      bg: "#0b0b0b",
      "bg-raise": "#141414",
      "bg-inset": "#070707",
      line: "#232323",
      "line-bright": "#646464",
      fg: "#ededed",
      "fg-dim": "#c8c8c8",
      "fg-faint": "#9a9a9a",
      ok: "#dcdcdc",
      warn: "#9a9a9a",
      bad: "#e26d6d",
      off: "#6a6a6a",
      info: "#c4c4c4",
      link: "#c4c4c4",
      good: "#c8c8c8",
      accent: "#d6d6d6",
      focus: "#c4c4c4",
      "sel-bg": "#e9e9e9",
      "sel-fg": "#0b0b0b",
    },
  },
  {
    name: "frost",
    label: "Frost (light)",
    // cool blueprint-paper: a crisp blue-white field with cobalt / steel-blue ink
    palette: {
      bg: "#eef3f8",
      "bg-raise": "#f9fbfd",
      "bg-inset": "#e0e8f1",
      line: "#c4d2e2",
      "line-bright": "#6c8199",
      fg: "#0e1a26",
      "fg-dim": "#36495c",
      "fg-faint": "#566a7e",
      ok: "#15705f",
      warn: "#7e5600",
      bad: "#a52521",
      off: "#728294",
      info: "#1f57a4",
      link: "#1f57a4",
      good: "#15705f",
      accent: "#5a32b0",
      focus: "#1f57a4",
      "sel-bg": "#15263a",
      "sel-fg": "#eef3f8",
    },
  },
  {
    name: "sage",
    label: "Sage (light)",
    // herbarium paper: softly desaturated botanical greens, restful and archival
    palette: {
      bg: "#eef1e9",
      "bg-raise": "#f8faf4",
      "bg-inset": "#e2e6d8",
      line: "#cdd3c0",
      "line-bright": "#7f8a6e",
      fg: "#1b2014",
      "fg-dim": "#3d4630",
      "fg-faint": "#5c6647",
      ok: "#2a722a",
      warn: "#785800",
      bad: "#a32b22",
      off: "#7d846f",
      info: "#155a64",
      link: "#155a64",
      good: "#246424",
      accent: "#5a3fa8",
      focus: "#155a64",
      "sel-bg": "#283021",
      "sel-fg": "#eef1e9",
    },
  },
  {
    name: "linen",
    label: "Linen (light)",
    // blush-grey textile: rose-tinted paper with a mauve accent, gentle + editorial
    palette: {
      bg: "#f3edee",
      "bg-raise": "#fbf7f8",
      "bg-inset": "#e9e0e2",
      line: "#dccfd2",
      "line-bright": "#947f83",
      fg: "#1b1417",
      "fg-dim": "#463a3d",
      "fg-faint": "#665559",
      ok: "#13714a",
      warn: "#7c520e",
      bad: "#9f2632",
      off: "#857579",
      info: "#7a3f73",
      link: "#7a3f73",
      good: "#13714a",
      accent: "#8a3fb0",
      focus: "#7a3f73",
      "sel-bg": "#241a1d",
      "sel-fg": "#f3edee",
    },
  },
];

const ACTIVE_KEY = "mesh.theme";
const CUSTOM_KEY = "mesh.theme.custom";

/** A CSS hex color: #rgb or #rrggbb. We only ever write hex into the theme CSS vars, so
 *  this is the validation boundary for stored / imported palette values. */
export const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const isHexColor = (v: unknown): v is string => typeof v === "string" && HEX_RE.test(v.trim());

export function isPalette(v: unknown): v is Palette {
  return !!v && typeof v === "object" && THEME_KEYS.every((k) => isHexColor((v as any)[k]));
}

/** Forward-migrate AND sanitize a possibly-stale / untrusted stored palette. A custom
 *  palette saved before a token was introduced (e.g. good/accent/focus) is missing keys;
 *  an imported / hand-edited one may carry malformed or arbitrary values. For every token
 *  we keep the stored value ONLY if it is a valid hex color, otherwise fall back to the
 *  default preset — so the result is always a complete, all-hex palette and we never push
 *  an arbitrary string into a CSS var. Returns null only when the input isn't a palette at
 *  all (not an object, or carries neither a valid bg nor fg to anchor on). */
export function migratePalette(v: unknown): Palette | null {
  if (!v || typeof v !== "object") return null;
  const src = v as Record<string, unknown>;
  const base = BUILTIN_THEMES[0].palette;
  let filledAny = false;
  const out = {} as Palette;
  for (const k of THEME_KEYS) {
    if (isHexColor(src[k])) out[k] = (src[k] as string).trim();
    else if (k === "link" && isHexColor(src["info"])) {
      // `link` was promoted from a bare CSS var to a first-class token. A palette saved
      // before that has no `link`; seed it from the palette's OWN `info` (same role/hue,
      // already contrast-checked) so an upgrade doesn't recolor existing links to the
      // default theme's link. Only fall through to the default `link` when `info` is
      // unusable too (handled by the branch below).
      out[k] = (src["info"] as string).trim();
      filledAny = true;
    } else {
      out[k] = base[k];
      filledAny = true;
    }
  }
  // a totally unrelated object (no valid surface/text color at all) is not a palette we
  // should silently adopt — only forgive missing/malformed tokens around a real anchor.
  if (filledAny && !isHexColor(src["bg"]) && !isHexColor(src["fg"])) return null;
  return out;
}

export function applyPalette(p: Palette): void {
  const root = document.documentElement;
  for (const k of THEME_KEYS) root.style.setProperty(`--${k}`, p[k]);
  // Keep the v2 semantic layer (Step 5 C2) in sync: applying a v1 preset / custom
  // palette through the existing ThemePicker must also refresh `--surface`,
  // `--accent`, `--on-*`, etc. — otherwise semantic-token components (later steps)
  // would keep the previous composition's values, producing a mixed theme.
  // Derive from a SANITIZED palette: the custom-theme editor live-previews on every
  // keystroke (partial values like "#12"), so feed migratePalette() — never raw p —
  // into v1PaletteToSemantic so hexToRgb can't throw and crash the editor. The legacy
  // raw inputs are still written above (browser ignores an invalid CSS var); a later
  // valid keystroke re-runs this and refreshes the semantic layer.
  // (v1PaletteToSemantic / SEMANTIC_KEYS are defined below; referenced at call time.)
  const s = v1PaletteToSemantic(migratePalette(p) ?? BUILTIN_THEMES[0].palette);
  for (const k of SEMANTIC_KEYS) root.style.setProperty(`--${k}`, s[k]);
}

export function themeByName(name: string): Theme {
  return BUILTIN_THEMES.find((t) => t.name === name) ?? BUILTIN_THEMES[0];
}

export function loadCustomPalette(): Palette {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw) {
      const migrated = migratePalette(JSON.parse(raw));
      if (migrated) return migrated;
    }
  } catch {
    /* unavailable / corrupt */
  }
  return { ...BUILTIN_THEMES[0].palette };
}

export function saveCustomPalette(p: Palette): void {
  try {
    // sanitize at the persistence boundary: any malformed value typed into the editor is
    // normalized to a valid hex (or the default) before it ever reaches localStorage / CSS.
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(migratePalette(p) ?? BUILTIN_THEMES[0].palette));
  } catch {
    /* unavailable */
  }
}

export function loadActive(): { name: string; palette: Palette } {
  let name = "phosphor";
  try {
    name = localStorage.getItem(ACTIVE_KEY) || "phosphor";
  } catch {
    /* unavailable */
  }
  if (name === "custom") return { name, palette: loadCustomPalette() };
  const t = themeByName(name);
  return { name: t.name, palette: t.palette };
}

export function saveActive(name: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, name);
  } catch {
    /* unavailable */
  }
}

// ════════════════════════════════════════════════════════════════════════════
// v2 token system (Step 5 C2) — two-layer, orthogonal mode × accent runtime.
// Source of truth: docs/design/ui/tokens/{00,01,02}.md. COEXISTS with the v1
// 19-key model above: applyComposition() writes the v2 semantic vars AND derives
// the legacy 19 vars, so the (un-migrated) theme.css keeps rendering under the v2
// default. C3 owns the contrast-threshold / a11y-gate upgrade; this commit lands
// only the runtime + storage + migration shim (no component primitives).
// ════════════════════════════════════════════════════════════════════════════

export const MODES = ["dark-slate", "light-cool", "eye-care-warm"] as const;
export type Mode = (typeof MODES)[number];
export const ACCENTS = ["signal-teal", "ember", "fleet-azure"] as const;
export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_MODE: Mode = "dark-slate";
export const DEFAULT_ACCENT: Accent = "signal-teal";

// Raw 11-stop scales (50→950) — components MUST NOT reference these directly
// (Tailwind lint-discourages `raw-*`); semantic tokens below alias into them.
type Ramp = Record<number, string>;
const RAW: Record<string, Ramp> = {
  slate: { 50: "#e9eef4", 100: "#d9e0e8", 200: "#c4ccd6", 300: "#a4adba", 400: "#828b97", 500: "#5f6772", 600: "#444c56", 700: "#2d343d", 800: "#1b212a", 900: "#0e1117", 950: "#06080c" },
  cool: { 50: "#f9fbfd", 100: "#eef3f8", 200: "#e0e8f1", 300: "#c4d2e2", 400: "#93a8bf", 500: "#6c8199", 600: "#51677e", 700: "#36495c", 800: "#233547", 900: "#15222f", 950: "#0e1a26" },
  warm: { 50: "#fbf5e6", 100: "#f3ead6", 200: "#ece0c8", 300: "#ddcfb0", 400: "#c2ad84", 500: "#8a7a55", 600: "#6a5c41", 700: "#4a3f2c", 800: "#382f1f", 900: "#2b2317", 950: "#1c160d" },
  green: { 50: "#f0fdf4", 100: "#dcfce7", 200: "#bbf7d0", 300: "#86efac", 400: "#4ade80", 500: "#22c55e", 600: "#16a34a", 700: "#15803d", 800: "#166534", 900: "#14532d", 950: "#052e16" },
  amber: { 50: "#fffbeb", 100: "#fef3c7", 200: "#fde68a", 300: "#fcd34d", 400: "#fbbf24", 500: "#f59e0b", 600: "#d97706", 700: "#b45309", 800: "#92400e", 900: "#78350f", 950: "#451a03" },
  red: { 50: "#fef2f2", 100: "#fee2e2", 200: "#fecaca", 300: "#fca5a5", 400: "#f87171", 500: "#ef4444", 600: "#dc2626", 700: "#b91c1c", 800: "#991b1b", 900: "#7f1d1d", 950: "#450a0a" },
  blue: { 50: "#eff6ff", 100: "#dbeafe", 200: "#bfdbfe", 300: "#93c5fd", 400: "#60a5fa", 500: "#3b82f6", 600: "#2563eb", 700: "#1d4ed8", 800: "#1e40af", 900: "#1e3a8a", 950: "#172554" },
  gray: { 50: "#f9fafb", 100: "#f3f4f6", 200: "#e5e7eb", 300: "#d1d5db", 400: "#9ca3af", 500: "#6b7280", 600: "#4b5563", 700: "#374151", 800: "#1f2937", 900: "#111827", 950: "#030712" },
  "signal-teal": { 50: "#f0fdfa", 100: "#ccfbf1", 200: "#99f6e4", 300: "#5eead4", 400: "#2dd4bf", 500: "#14b8a6", 600: "#0d9488", 700: "#0f766e", 800: "#115e59", 900: "#134e4a", 950: "#042f2e" },
  ember: { 50: "#fff7ed", 100: "#ffedd5", 200: "#fed7aa", 300: "#fdba74", 400: "#fb923c", 500: "#f97316", 600: "#ea580c", 700: "#c2410c", 800: "#9a3412", 900: "#7c2d12", 950: "#431407" },
  "fleet-azure": { 50: "#f0f9ff", 100: "#e0f2fe", 200: "#bae6fd", 300: "#7dd3fc", 400: "#38bdf8", 500: "#0ea5e9", 600: "#0284c7", 700: "#0369a1", 800: "#075985", 900: "#0c4a6e", 950: "#082f49" },
};

interface ModeSpec {
  neutral: string;
  dark: boolean;
  surface: number; raised: number; sunken: number; border: number; borderStrong: number;
  textPrimary: number; textSecondary: number; textMuted: number; textDisabled: number;
  statusStop: number; warnStop: number; accentStop: number;
}
// Per-mode semantic stop map (docs/design/ui/tokens/01-palettes.md, Layer B).
const MODE_SPEC: Record<Mode, ModeSpec> = {
  "dark-slate": { neutral: "slate", dark: true, surface: 900, raised: 800, sunken: 950, border: 700, borderStrong: 300, textPrimary: 50, textSecondary: 200, textMuted: 300, textDisabled: 400, statusStop: 400, warnStop: 400, accentStop: 400 },
  "light-cool": { neutral: "cool", dark: false, surface: 100, raised: 50, sunken: 200, border: 300, borderStrong: 600, textPrimary: 950, textSecondary: 700, textMuted: 600, textDisabled: 500, statusStop: 800, warnStop: 800, accentStop: 700 },
  "eye-care-warm": { neutral: "warm", dark: false, surface: 100, raised: 50, sunken: 200, border: 300, borderStrong: 600, textPrimary: 900, textSecondary: 700, textMuted: 600, textDisabled: 500, statusStop: 800, warnStop: 800, accentStop: 700 },
};
// Per-(mode,accent) accent-stop override so all 9 combinations clear contrast
// (decision 4): Eye-care × Ember needs the darker 800 on the cream field.
const ACCENT_STOP_OVERRIDE: Partial<Record<Mode, Partial<Record<Accent, number>>>> = {
  "eye-care-warm": { ember: 800 },
};

// Component-facing semantic tokens. Components use ONLY these (never RAW).
export const SEMANTIC_KEYS = [
  "surface", "surface-raised", "surface-sunken", "surface-overlay",
  "border", "border-strong",
  "text-primary", "text-secondary", "text-muted", "text-disabled",
  "success", "warning", "danger", "info", "link", "idle",
  "success-subtle", "warning-subtle", "danger-subtle", "info-subtle",
  "on-success", "on-warning", "on-danger", "on-info",
  "accent", "accent-hover", "accent-active", "accent-subtle", "on-accent",
  "hover", "active", "selected", "text-on-selected", "focus-ring", "disabled",
  "syntax-keyword", "syntax-string", "syntax-comment",
] as const;
export type SemanticVar = (typeof SEMANTIC_KEYS)[number];
export type SemanticPalette = Record<SemanticVar, string>;

const rgbToHex = (o: { r: number; g: number; b: number }) =>
  "#" + [o.r, o.g, o.b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
/** Foreground for a filled status/accent surface — black or white by measured
 *  contrast (NOT assumed white; bright fills take near-black). */
const onPick = (fill: string): string => (contrastRatio(fill, "#ffffff") >= contrastRatio(fill, "#0b0b0b") ? "#ffffff" : "#0b0b0b");

/** Resolve one of the 9 built-in (mode × accent) combinations to a full semantic palette. */
export function compose(mode: Mode, accent: Accent): SemanticPalette {
  const m = MODE_SPEC[mode];
  const n = m.neutral;
  const c = (ramp: string, stop: number) => RAW[ramp][stop];
  const surface = c(n, m.surface), raised = c(n, m.raised), sunken = c(n, m.sunken);
  const accentStop = ACCENT_STOP_OVERRIDE[mode]?.[accent] ?? m.accentStop;
  const acc = c(accent, accentStop);
  const subtle = (ramp: string) => rgbToHex(blend(hexToRgb(c(ramp, 500)), 0.14, hexToRgb(surface)));
  const wash = (pct: number) => rgbToHex(blend(hexToRgb(c(n, m.textPrimary)), pct, hexToRgb(surface)));
  const success = c("green", m.statusStop), warning = c("amber", m.warnStop), danger = c("red", m.statusStop), info = c("blue", m.statusStop);
  return {
    surface, "surface-raised": raised, "surface-sunken": sunken, "surface-overlay": wash(0.55),
    border: c(n, m.border), "border-strong": c(n, m.borderStrong),
    "text-primary": c(n, m.textPrimary), "text-secondary": c(n, m.textSecondary), "text-muted": c(n, m.textMuted), "text-disabled": c(n, m.textDisabled),
    success, warning, danger, info, link: info, idle: c("gray", m.dark ? 400 : 600),
    "success-subtle": subtle("green"), "warning-subtle": subtle("amber"), "danger-subtle": subtle("red"), "info-subtle": subtle("blue"),
    "on-success": onPick(success), "on-warning": onPick(warning), "on-danger": onPick(danger), "on-info": onPick(info),
    accent: acc, "accent-hover": c(accent, accentStop - 100), "accent-active": c(accent, Math.min(accentStop + 100, 950)),
    "accent-subtle": subtle(accent), "on-accent": onPick(acc),
    hover: wash(0.05), active: wash(0.09), selected: subtle(accent), "text-on-selected": c(n, m.textPrimary),
    "focus-ring": info, disabled: surface,
    "syntax-keyword": info, "syntax-string": success, "syntax-comment": c(n, m.textMuted),
  };
}

// Legacy 19-key var ← semantic var, so un-migrated theme.css renders under v2.
// sel-bg/sel-fg keep the v1 inverted-selection look (fg-as-bg / bg-as-fg).
const V1_FROM_SEMANTIC: Record<ThemeVar, SemanticVar> = {
  bg: "surface", "bg-raise": "surface-raised", "bg-inset": "surface-sunken",
  line: "border", "line-bright": "border-strong",
  fg: "text-primary", "fg-dim": "text-secondary", "fg-faint": "text-muted",
  ok: "success", warn: "warning", bad: "danger", off: "idle", info: "info", link: "link", good: "success",
  accent: "accent", focus: "focus-ring", "sel-bg": "text-primary", "sel-fg": "surface",
};

/** Write a semantic palette to :root — both the v2 vars and the derived legacy
 *  19 vars (so theme.css works during the incremental migration). */
export function applyComposition(c: SemanticPalette): void {
  const root = document.documentElement;
  for (const k of SEMANTIC_KEYS) root.style.setProperty(`--${k}`, c[k]);
  for (const k of THEME_KEYS) root.style.setProperty(`--${k}`, c[V1_FROM_SEMANTIC[k]]);
}

/** v1 19-key → v2 semantic migration/fallback shim. Best-effort derivation so a
 *  stored v1 custom palette still renders under v2: status `*-subtle`/`on-*` and
 *  the interaction washes are derived from the v1 values (no raw ramp available).
 *  The 19-key input should already be sanitized via migratePalette() (which seeds
 *  a missing link from info + backfills missing keys). */
export function v1PaletteToSemantic(p: Palette): SemanticPalette {
  const surface = p.bg;
  const subtle = (hex: string) => rgbToHex(blend(hexToRgb(hex), 0.14, hexToRgb(surface)));
  const wash = (pct: number) => rgbToHex(blend(hexToRgb(p.fg), pct, hexToRgb(surface)));
  return {
    surface, "surface-raised": p["bg-raise"], "surface-sunken": p["bg-inset"], "surface-overlay": wash(0.55),
    border: p.line, "border-strong": p["line-bright"],
    "text-primary": p.fg, "text-secondary": p["fg-dim"], "text-muted": p["fg-faint"], "text-disabled": p["fg-faint"],
    success: p.ok, warning: p.warn, danger: p.bad, info: p.info, link: p.link, idle: p.off,
    "success-subtle": subtle(p.ok), "warning-subtle": subtle(p.warn), "danger-subtle": subtle(p.bad), "info-subtle": subtle(p.info),
    "on-success": onPick(p.ok), "on-warning": onPick(p.warn), "on-danger": onPick(p.bad), "on-info": onPick(p.info),
    accent: p.accent, "accent-hover": p.accent, "accent-active": p.accent, "accent-subtle": subtle(p.accent), "on-accent": onPick(p.accent),
    hover: wash(0.05), active: wash(0.09), selected: subtle(p.accent), "text-on-selected": p.fg,
    "focus-ring": p.focus, disabled: surface,
    "syntax-keyword": p.info, "syntax-string": p.good, "syntax-comment": p["fg-faint"],
  };
}

// Two independent, runtime-switchable persisted choices (orthogonal axes).
const MODE_KEY = "mesh.theme.mode";
const ACCENT_KEY = "mesh.theme.accent";

export function loadThemeSelection(): { mode: Mode; accent: Accent } {
  let mode: Mode = DEFAULT_MODE;
  let accent: Accent = DEFAULT_ACCENT;
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m && (MODES as readonly string[]).includes(m)) mode = m as Mode;
    const a = localStorage.getItem(ACCENT_KEY);
    if (a && (ACCENTS as readonly string[]).includes(a)) accent = a as Accent;
  } catch {
    /* unavailable */
  }
  return { mode, accent };
}
export function saveMode(m: Mode): void {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* unavailable */ }
}
export function saveAccent(a: Accent): void {
  try { localStorage.setItem(ACCENT_KEY, a); } catch { /* unavailable */ }
}

/** Apply the persisted theme (call once, before first paint).
 *  An explicit v1 selection ("mesh.theme" = a built-in name, or "custom") is
 *  honored first — this preserves returning users' legacy choice and keeps the
 *  existing ThemePicker + a11y theme-switch (which set "mesh.theme") working. A
 *  fresh / non-legacy state falls through to the v2 composition, default
 *  Dark·Slate × Signal Teal. (The mode/accent ThemePicker UI is a later commit.) */
export function initTheme(): void {
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(ACTIVE_KEY); } catch { /* unavailable */ }
  if (legacy === "custom") {
    applyPalette(loadCustomPalette()); // writes faithful legacy vars + synced semantic layer
    return;
  }
  if (legacy && BUILTIN_THEMES.some((t) => t.name === legacy)) {
    applyPalette(themeByName(legacy).palette);
    return;
  }
  const { mode, accent } = loadThemeSelection();
  applyComposition(compose(mode, accent));
}
