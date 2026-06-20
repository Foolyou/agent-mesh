// src/channels/i18n/index.ts — small, channel-local i18n core (design: docs/design/channel-i18n-prompts.md).
//
// Generated channel system/notification copy goes through `t(key, params?)` instead of inline strings,
// so the wording lives in one place and is translatable. Default locale is `en` (the only bundle today);
// more bundles register later. Lookup falls back active-locale → `en` → the key itself, so a partial or
// missing bundle never crashes a reply. Interpolation replaces `{name}` tokens (incl. `{n}`); a missing
// param interpolates to an empty string (never throws). This module is intentionally tiny and has no
// dependency on the rest of the system — call sites are migrated in later commits, not here.

import { en } from "./en";

export type Locale = string;
export type Bundle = Record<string, string>;
/** Interpolation params: strings or numbers (numbers are stringified for `{n}`-style counts). */
export type Params = Record<string, string | number>;

const bundles: Record<Locale, Bundle> = { en };
let currentLocale: Locale = "en";

/** Register (or replace) a locale bundle. `en` is always present as the fallback. */
export function registerBundle(locale: Locale, bundle: Bundle): void {
  bundles[locale] = bundle;
}

/** The reserved config switch for the global default locale (per-binding override comes later via the
 *  `locale` arg to `t`). */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** Replace `{name}` tokens from `params`. An absent/null param → empty string. Never throws. */
function interpolate(tpl: string, params?: Params): string {
  return tpl.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const v = params?.[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Look up `key` in the active locale (or the explicit `locale`), falling back to `en` and finally to
 *  the literal key, then interpolate `params`. The `locale` arg is the seam for per-binding locale. */
export function t(key: string, params?: Params, locale: Locale = currentLocale): string {
  const tpl = bundles[locale]?.[key] ?? bundles.en[key] ?? key;
  return interpolate(tpl, params);
}

/** True if `key` resolves in the active locale or `en` (a missing key returns the literal key from `t`).
 *  Exposed for the lookup-coverage test. */
export function hasKey(key: string, locale: Locale = currentLocale): boolean {
  return bundles[locale]?.[key] !== undefined || bundles.en[key] !== undefined;
}

export { en };
