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

// Each preset is a full, contrast-checked palette (fg-faint ≳ 4.5:1 on bg).
export const BUILTIN_THEMES: Theme[] = [
  {
    name: "phosphor",
    label: "Phosphor",
    palette: {
      bg: "#0a0b0d",
      "bg-raise": "#101216",
      "bg-inset": "#07080a",
      line: "#1c1f24",
      "line-bright": "#2b2f36",
      fg: "#e8eae5",
      "fg-dim": "#c2c8cf",
      "fg-faint": "#99a0a8",
      ok: "#4ec97a",
      warn: "#e2b341",
      bad: "#f0584b",
      off: "#5a6068",
      info: "#5ac8e0",
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
      "line-bright": "#43301a",
      fg: "#f6cf94",
      "fg-dim": "#e2bf82",
      "fg-faint": "#b8945c",
      ok: "#a7cf4f",
      warn: "#ffb02e",
      bad: "#ff5e46",
      off: "#7a6238",
      info: "#e8a13a",
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
      "line-bright": "#293a4c",
      fg: "#e2ebf3",
      "fg-dim": "#bccddd",
      "fg-faint": "#90a3b8",
      ok: "#4ec9b0",
      warn: "#e2b341",
      bad: "#f0586b",
      off: "#5a6878",
      info: "#5aa8e0",
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
      "line-bright": "#bfbcae",
      fg: "#16150f",
      "fg-dim": "#403e38",
      "fg-faint": "#5e5c55",
      ok: "#1f9d57",
      warn: "#b07d18",
      bad: "#c0392b",
      off: "#9a988f",
      info: "#2b7fb0",
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
      "line-bright": "#363636",
      fg: "#ededed",
      "fg-dim": "#c8c8c8",
      "fg-faint": "#9a9a9a",
      ok: "#dcdcdc",
      warn: "#9a9a9a",
      bad: "#e26d6d",
      off: "#5a5a5a",
      info: "#c4c4c4",
      "sel-bg": "#e9e9e9",
      "sel-fg": "#0b0b0b",
    },
  },
];

const ACTIVE_KEY = "mesh.theme";
const CUSTOM_KEY = "mesh.theme.custom";

export function isPalette(v: unknown): v is Palette {
  return !!v && typeof v === "object" && THEME_KEYS.every((k) => typeof (v as any)[k] === "string");
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
      const p = JSON.parse(raw);
      if (isPalette(p)) return p;
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
