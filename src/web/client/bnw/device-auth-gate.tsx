// Step 7.4-A.2b-ii (2/2) — Device-auth gate (mockup 12) for the /bnw namespace. A pre-auth
// wrapper (BnwBoot) that replaces the console until an approved device token exists. Reuses the
// SHARED device-auth data layer (bootAuthorized / runEnrollment / submitBootstrap) — it does NOT
// import or modify the old Boot view component, so the old root UI gate is unchanged.
//
// Security invariants preserved (display/flow migration only, NOT a relaxation):
//  - an approved device token is the ONLY allow path (bootAuthorized probes the gated /api/state);
//  - the one-time bootstrap token is body-only (submitBootstrap), never persisted, never in the URL;
//  - fail-closed: revoked/unknown/expired and bootstrap failures surface generic, non-leaky copy;
//  - `?next` is open-redirect-guarded to same-origin /bnw targets only.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Input, Spinner } from "../ui/index";
import { bootAuthorized, runEnrollment, submitBootstrap, type DeviceAuthPhase } from "../device-auth";
import { BNW_PREFIX, isBnwPath } from "../router";
import { useI18n, type TFn } from "../i18n";

type BootPhase = "checking" | "authorized" | "unauthorized";
const DEVICE_AUTH_PATH = `${BNW_PREFIX}/device-auth`;

/** The post-approval return target: an explicit `?next` (guarded to /bnw) or the current deep link. */
function rememberedTarget(): string {
  const here = window.location.pathname + window.location.search;
  const next = new URLSearchParams(window.location.search).get("next");
  // open-redirect guard: honor ONLY targets inside the /bnw namespace. `isBnwPath` is strict
  // (`/bnw` or `/bnw/…`), so it rejects both external origins and look-alikes like `/bnw.evil`.
  if (next && isBnwPath(next.split(/[?#]/, 1)[0])) return next;
  if (window.location.pathname === DEVICE_AUTH_PATH) return BNW_PREFIX;
  return here.startsWith(BNW_PREFIX) ? here : BNW_PREFIX;
}

export function BnwBoot({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<BootPhase>("checking");
  useEffect(() => {
    let cancelled = false;
    bootAuthorized().then((ok) => { if (!cancelled) setPhase(ok ? "authorized" : "unauthorized"); });
    return () => { cancelled = true; };
  }, []);

  if (phase === "authorized") {
    // An already-authorized device that lands on the gate URL bounces to the remembered/next target.
    if (typeof window !== "undefined" && window.location.pathname === DEVICE_AUTH_PATH) {
      const target = rememberedTarget();
      if (target !== window.location.pathname + window.location.search) { window.location.replace(target); return null; }
    }
    return <>{children}</>;
  }
  if (phase === "checking") {
    return <GateShell><div className="flex items-center justify-center gap-2 py-6 text-sm text-text-secondary"><Spinner size={16} label="checking" /> {t("bnw.da.checking")}</div></GateShell>;
  }
  return <BnwDeviceAuthGate onApproved={() => {
    const target = rememberedTarget();
    if (target !== window.location.pathname + window.location.search) window.location.replace(target);
    else setPhase("authorized");
  }} />;
}

function GateShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div data-device-auth="gate" className="flex min-h-[100dvh] flex-col items-center justify-center bg-surface p-6 font-sans text-text-primary">
      <div className="flex w-full max-w-[460px] flex-col gap-4 rounded-2xl border border-border bg-surface-raised p-6">
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="inline-flex items-center gap-1.5 font-semibold"><span aria-hidden="true">◆</span> Mesh</span>
          <h1 className="text-lg font-semibold">{t("bnw.da.title")}</h1>
          <p className="text-xs text-text-muted">{t("bnw.da.subtitle")}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function statusLine(s: DeviceAuthPhase, t: TFn): string {
  if (s === "revoked") return t("bnw.da.revoked");
  if (s === "unknown") return t("bnw.da.unknown");
  return t("bnw.da.pending"); // pending
}

export function BnwDeviceAuthGate({ onApproved }: { onApproved: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState<string | null>(null);
  const [status, setStatus] = useState<DeviceAuthPhase>("pending");
  const [failed, setFailed] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [bsError, setBsError] = useState(false);
  const started = useRef(false);
  const remembered = typeof window !== "undefined" ? rememberedTarget() : BNW_PREFIX;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = token.trim();
    if (!t || busy) return;
    setBusy(true); setBsError(false);
    const ok = await submitBootstrap(t);
    setBusy(false);
    if (ok) onApproved(); else setBsError(true); // generic — never reveals which part failed
  }

  useEffect(() => {
    if (started.current) return; // StrictMode double-invoke guard: enroll exactly once
    started.current = true;
    let cancelled = false;
    runEnrollment(
      { onCode: (c) => !cancelled && setCode(c), onStatus: (s) => !cancelled && setStatus(s) },
      fetch, undefined, () => !cancelled,
    ).then((outcome) => {
      if (cancelled) return;
      if (outcome === "approved") onApproved();
      else if (outcome === "failed") setFailed(true);
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <GateShell>
      {failed ? (
        <div role="status" className="rounded-lg bg-danger-subtle px-3 py-2 text-xs text-danger">{t("bnw.da.failed")}</div>
      ) : code ? (
        <>
          {status === "unknown" ? <div role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-xs text-danger">{t("bnw.da.invalid")}</div> : null}
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs uppercase tracking-wider text-text-muted">{t("bnw.da.deviceCodeLabel")}</span>
            <code data-device-code className="break-all rounded-lg border border-border-strong bg-surface-sunken px-4 py-2 font-mono text-2xl font-semibold tracking-widest text-text-primary">{code}</code>
            <span className="text-center text-xs text-text-muted">{t("bnw.da.approveHintPre")}<code className="font-mono text-text-secondary">mesh device approve {code}</code>{t("bnw.da.approveHintPost")}</span>
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-text-secondary"><Spinner size={12} label="polling" /> {statusLine(status, t)}</div>
          <div className="flex items-center gap-2 text-xs text-text-muted"><span className="h-px flex-1 bg-border" aria-hidden="true" />{t("bnw.da.or")}<span className="h-px flex-1 bg-border" aria-hidden="true" /></div>
          <form data-bootstrap className="flex flex-col gap-1.5" onSubmit={onSubmit}>
            <label className="text-xs uppercase tracking-wider text-text-muted">{t("bnw.da.bootstrapLabel")}</label>
            <Input aria-label="bootstrap token" autoComplete="off" spellCheck={false} value={token} placeholder={t("bnw.da.bootstrapPlaceholder")} onChange={(e) => setToken(e.target.value)} className="w-full font-mono" />
            <span className="text-xs text-text-muted">{t("bnw.da.bootstrapNote")}</span>
            <Button type="submit" variant="primary" busy={busy} disabled={busy || !token.trim()} aria-label="submit bootstrap token" className="w-full">{busy ? t("bnw.da.submitting") : t("bnw.da.selfApprove")}</Button>
            {bsError ? <div role="status" className="text-xs text-danger">{t("bnw.da.bsError")}</div> : null}
          </form>
          <div data-remembered className="rounded-lg border border-border bg-surface-sunken px-3 py-2 text-xs text-text-muted">{t("bnw.da.willReturn")}<code className="break-all font-mono text-text-secondary">{remembered}</code></div>
          <p className="text-center text-[11px] text-text-muted">{t("bnw.da.footerPre")}<code className="font-mono">/api/*</code>{t("bnw.da.footerPost")}</p>
        </>
      ) : (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-text-secondary"><Spinner size={16} label="requesting code" /> {t("bnw.da.requestingCode")}</div>
      )}
    </GateShell>
  );
}
