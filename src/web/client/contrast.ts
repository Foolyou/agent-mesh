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
