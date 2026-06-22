// i18n foundation slice — React provider that holds the active language and re-renders the
// subtree when it changes (via subscribeLang). Mounted at the /bnw root (index.tsx → BnwApp) so
// shell/nav copy switches en↔zh immediately without a refresh. Reuses i18n.ts (translate /
// I18nContext / loadLang / saveLang); does not touch old-UI i18n wiring.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { I18nContext, loadLang, subscribeLang, translate, type Lang, type TFn } from "./i18n";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(loadLang);
  // Any saveLang() (e.g. the settings language tab) broadcasts → update + re-render here.
  useEffect(() => subscribeLang(setLang), []);
  // Keep <html lang> in sync on mount + change (saveLang also sets it; this covers initial load).
  useEffect(() => { try { document.documentElement.lang = lang; } catch { /* SSR/no-DOM */ } }, [lang]);
  const value = useMemo(() => {
    const t: TFn = (key, vars) => translate(key, lang, vars);
    return { lang, t };
  }, [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
