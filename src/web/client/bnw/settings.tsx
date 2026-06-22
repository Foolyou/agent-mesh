// Step 7.4-B — Settings surface (mockup 09): appearance / language / preferences / devices,
// URL-addressable via ?tab. Independent /bnw view; shares only the data layer (themes.ts compose/
// applyComposition/custom-palette, i18n.ts saveLang, device-auth.ts pollDeviceStatus, bnw/prefs).
//
// Real wiring (no fakes):
//  - appearance writes :root via the real compose()/applyComposition() (mode×accent) + persists
//    saveMode/saveAccent (and clearActive so a legacy/custom selection doesn't shadow it); the
//    custom-palette editor live-applies via applyPalette + saveCustomPalette + saveActive("custom").
//  - language persists via saveLang (mesh.lang + <html lang>).
//  - preferences persist CLIENT-LOCAL (bnw/prefs) — explicitly not a server write.
//  - devices: read-only own-device status (pollDeviceStatus); list/approve/revoke/bootstrap stay
//    host-CLI authoritative (no web seam exists) → honest placeholder, like channels Option B.
//
// Deviation from mockup 09 (flagged): the mockup stacks all groups; the locked routing requires
// ?tab=appearance|language|prefs|devices, so the groups are rendered as URL-addressable tabs.
import { useEffect, useState, type ReactNode } from "react";
import { Button, Cluster, Input, PanelFrame, RouteLink, SegmentedControl, StatusChip, type Status } from "../ui/index";
import {
  MODES, ACCENTS, THEME_KEYS, type Mode, type Accent, type Palette,
  compose, applyComposition, saveMode, saveAccent, clearActive,
  loadThemeSelection, loadCustomPalette, applyPalette, saveCustomPalette, saveActive,
} from "../themes";
import { loadLang, saveLang, useI18n, type Lang } from "../i18n";
import { pollDeviceStatus, type DeviceAuthPhase } from "../device-auth";
import { loadDefaultView, saveDefaultView, loadDefaultDevice, saveDefaultDevice, type DefaultView, type DefaultDevice } from "./prefs";
import { bnwHref, type BnwRoute } from "../router";

type SettingsRoute = Extract<BnwRoute, { k: "settings" }>;
type Tab = "appearance" | "language" | "prefs" | "devices";
const TABS: { id: Tab; labelKey: string }[] = [
  { id: "appearance", labelKey: "bnw.set.tab.appearance" }, { id: "language", labelKey: "bnw.set.tab.language" },
  { id: "prefs", labelKey: "bnw.set.tab.prefs" }, { id: "devices", labelKey: "bnw.set.tab.devices" },
];
const MODE_LABEL: Record<Mode, string> = { "dark-slate": "Dark·Slate", "light-cool": "Light·Cool", "eye-care-warm": "Eye-care·Warm" };
const ACCENT_LABEL: Record<Accent, string> = { "signal-teal": "Signal Teal", ember: "Ember", "fleet-azure": "Fleet Azure" };

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">{title}</span>
      {children}
    </section>
  );
}

export function BnwSettings({ route }: { route: SettingsRoute }) {
  const tab: Tab = TABS.some((t) => t.id === route.tab) ? (route.tab as Tab) : "appearance";
  return (
    <PanelShell tab={tab}>
      {tab === "appearance" ? <AppearanceTab /> : tab === "language" ? <LanguageTab /> : tab === "prefs" ? <PrefsTab /> : <DevicesTab />}
    </PanelShell>
  );
}

function PanelShell({ tab, children }: { tab: Tab; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <PanelFrame title={t("bnw.set.title")} actions={<span className="text-xs text-text-muted">{t("bnw.set.localHint")}</span>} className="h-full" bodyClassName="min-h-0">
      <div data-settings="panel" className="flex min-h-0 flex-col">
        <nav aria-label="settings tabs" className="mb-3">
          <Cluster>
            {TABS.map((tb) => <RouteLink key={tb.id} href={bnwHref({ k: "settings", tab: tb.id })} active={tb.id === tab} className="text-sm">{t(tb.labelKey)}</RouteLink>)}
          </Cluster>
        </nav>
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">{children}</div>
      </div>
    </PanelFrame>
  );
}

function AppearanceTab() {
  const { t } = useI18n();
  const [{ mode, accent }, setSel] = useState(() => loadThemeSelection());
  const [palette, setPalette] = useState<Palette>(() => loadCustomPalette());

  function pickMode(m: Mode) { setSel({ mode: m, accent }); applyComposition(compose(m, accent)); saveMode(m); clearActive(); }
  function pickAccent(a: Accent) { setSel({ mode, accent: a }); applyComposition(compose(mode, a)); saveAccent(a); clearActive(); }
  function pickCombo(m: Mode, a: Accent) { setSel({ mode: m, accent: a }); applyComposition(compose(m, a)); saveMode(m); saveAccent(a); clearActive(); }
  function editPalette(key: string, value: string) {
    const next = { ...palette, [key]: value } as Palette;
    setPalette(next);
    applyPalette(next);           // live preview (migratePalette tolerates transient invalid hex)
    saveCustomPalette(next); saveActive("custom");
  }
  function resetToComposition() { applyComposition(compose(mode, accent)); clearActive(); }

  return (
    <Group title={t("bnw.set.appearanceTheme")}>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">{t("bnw.set.bgMode")}</span>
        <SegmentedControl ariaLabel="theme mode" value={mode} onChange={(m) => pickMode(m as Mode)} size="sm" options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">{t("bnw.set.accentLabel")}</span>
        <SegmentedControl ariaLabel="accent" value={accent} onChange={(a) => pickAccent(a as Accent)} size="sm" options={ACCENTS.map((a) => ({ value: a, label: ACCENT_LABEL[a] }))} />
      </div>
      {/* 9-combo live preview grid — each cell is a real selectable composition swatch. */}
      <div data-theme-matrix className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">{t("bnw.set.previewHint")}</span>
        <div className="grid grid-cols-3 gap-1.5">
          {MODES.flatMap((m) => ACCENTS.map((a) => {
            const c = compose(m, a);
            const on = m === mode && a === accent;
            return (
              <button key={`${m}-${a}`} type="button" data-theme-cell aria-label={`apply ${m} ${a}`} aria-pressed={on}
                onClick={() => pickCombo(m, a)}
                className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] ${on ? "border-border-strong outline outline-2 outline-offset-1 outline-focus-ring" : "border-border"}`}
                style={{ background: c.surface, color: c["text-secondary"] }}>
                <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: c.accent }} aria-hidden="true" />
                <span className="truncate">{m.replace("-", " ")} · {a.split("-")[0]}</span>
              </button>
            );
          }))}
        </div>
      </div>
      {/* Custom palette editor — live apply, tolerant of transient invalid hex (no throw). */}
      <details data-custom-palette className="rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5">
        <summary className="cursor-pointer text-xs text-text-muted">{t("bnw.set.customPalette")}</summary>
        <div className="mt-2 flex flex-col gap-1.5">
          {THEME_KEYS.map((k) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-20 shrink-0 font-mono text-xs text-text-secondary">{k}</span>
              <span className="h-5 w-5 shrink-0 rounded border border-border-strong" style={{ background: palette[k] }} aria-hidden="true" />
              <Input value={palette[k]} aria-label={`palette ${k}`} className="w-28 font-mono" onChange={(e) => editPalette(k, e.target.value)} />
            </div>
          ))}
          <div className="mt-1"><Button size="sm" variant="ghost" aria-label="reset to composition" onClick={resetToComposition}>{t("bnw.set.resetComposition")}</Button></div>
        </div>
      </details>
    </Group>
  );
}

function LanguageTab() {
  const { t } = useI18n();
  const [lang, setLangState] = useState<Lang>(() => loadLang());
  function pick(l: Lang) { setLangState(l); saveLang(l); }
  return (
    <Group title={t("bnw.set.languageTitle")}>
      <SegmentedControl ariaLabel="language" value={lang} onChange={(l) => pick(l as Lang)} size="sm" options={[{ value: "en", label: "English" }, { value: "zh", label: "中文" }]} />
      <span className="text-xs text-text-muted">{t("bnw.set.langNote1")}</span>
      <span className="text-xs text-text-muted">{t("bnw.set.langNote2")}</span>
    </Group>
  );
}

function PrefsTab() {
  const { t } = useI18n();
  const [view, setView] = useState<DefaultView>(() => loadDefaultView());
  const [dev, setDev] = useState<DefaultDevice>(() => loadDefaultDevice());
  return (
    <Group title={t("bnw.set.prefsTitle")}>
      <div className="flex flex-wrap items-start gap-6">
        <label className="flex flex-col gap-1 text-xs text-text-muted">{t("bnw.set.defaultView")}
          <SegmentedControl ariaLabel="default landing view" value={view} onChange={(v) => { setView(v as DefaultView); saveDefaultView(v as DefaultView); }} size="sm" options={[{ value: "runtime", label: t("bnw.runtime") }, { value: "board", label: t("bnw.board") }]} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">{t("bnw.set.defaultDevice")}
          <SegmentedControl ariaLabel="default device" value={dev} onChange={(d) => { setDev(d as DefaultDevice); saveDefaultDevice(d as DefaultDevice); }} size="sm" options={[{ value: "desktop", label: t("bnw.set.desktop") }, { value: "mobile", label: t("bnw.set.mobile") }]} />
        </label>
      </div>
      <span className="text-xs text-text-muted">{t("bnw.set.prefsNote")}</span>
    </Group>
  );
}

const DEV_TONE: Record<DeviceAuthPhase, Status> = { approved: "ready", pending: "attention", revoked: "blocked", unknown: "idle" };
function DevicesTab() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<DeviceAuthPhase | null>(null);
  useEffect(() => { let alive = true; void pollDeviceStatus().then((p) => { if (alive) setPhase(p); }); return () => { alive = false; }; }, []);
  return (
    <Group title={t("bnw.set.devicesTitle")}>
      <div data-device-row className="flex flex-wrap items-center gap-2 text-sm">
        <StatusChip status={phase ? DEV_TONE[phase] : "idle"} variant="dot" />
        <span className="font-medium text-text-primary">{t("bnw.set.thisDevice")}</span>
        <StatusChip status={phase ? DEV_TONE[phase] : "idle"} variant="soft" label={phase ?? t("bnw.set.checking")} />
      </div>
      {/* Honest placeholder (no web seam exists): list/approve/revoke/bootstrap are host-CLI authoritative. */}
      <div data-device-mgmt className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border bg-surface-sunken px-2.5 py-1.5">
        <span className="text-xs text-text-muted">{t("bnw.set.devicesCliHint")}</span>
        <code className="font-mono text-xs text-text-secondary">mesh device list | approve &lt;code&gt; | revoke &lt;deviceId|label&gt;</code>
        <code className="font-mono text-xs text-text-secondary">mesh auth bootstrap [--ttl &lt;seconds&gt;]</code>
        <span className="text-xs text-text-muted">{t("bnw.set.devicesNote")}</span>
      </div>
    </Group>
  );
}
