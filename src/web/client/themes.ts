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

export function isPalette(v: unknown): v is Palette {
  return !!v && typeof v === "object" && THEME_KEYS.every((k) => typeof (v as any)[k] === "string");
}

/** Forward-migrate a possibly-stale stored palette: a custom palette saved before a
 *  token was introduced (e.g. good/accent/focus) is missing keys. Rather than reject
 *  it (which would snap the user back to the default theme and lose their colors), we
 *  fill every missing token from the default preset so the palette stays complete and
 *  the app never crashes on an out-of-date localStorage value. Returns null only when
 *  the input is not a usable object at all. */
export function migratePalette(v: unknown): Palette | null {
  if (!v || typeof v !== "object") return null;
  const src = v as Record<string, unknown>;
  const base = BUILTIN_THEMES[0].palette;
  let filledAny = false;
  const out = {} as Palette;
  for (const k of THEME_KEYS) {
    const val = src[k];
    if (typeof val === "string") out[k] = val;
    else {
      out[k] = base[k];
      filledAny = true;
    }
  }
  // require at least the legacy core to have been present — a totally unrelated object
  // (no surfaces/text at all) is not a palette we should silently adopt.
  if (filledAny && typeof src["bg"] !== "string" && typeof src["fg"] !== "string") return null;
  return out;
}

export function applyPalette(p: Palette): void {
  const root = document.documentElement;
  for (const k of THEME_KEYS) root.style.setProperty(`--${k}`, p[k]);
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
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(p));
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

/** Apply the persisted theme (call once, before first paint). */
export function initTheme(): void {
  applyPalette(loadActive().palette);
}
