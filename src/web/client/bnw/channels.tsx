// Step 7.4-A.2b-i — Channels / Feishu surface (mockup 07, Option B). Wires only the EXISTING
// safe web APIs (getFeishuStatus / startFeishuProvision+poll/cancel / syncFeishuMeshChats /
// ensureFeishuMeshChat). Independent /bnw view tree; never imports the old FeishuPanel.
//
// SECURITY-DRIVEN DEVIATION (prdmgr-approved Option B): the PendingSenders (authcode approve/
// revoke) and AuthorizedSenders (allowSenders revoke) sections of mockup 07 are rendered as
// explicit placeholders only — no fake actions. Sender authorization is host-CLI authoritative
// (`mesh channels feishu list|approve|revoke`); a web admin seam over auth-store is deferred to
// the device-auth/auth-store slice. See coverage/07-channels.md change log.
import { useEffect, useState } from "react";
import { Button, Cluster, ErrorBanner, PanelFrame, Skeleton, Spinner, StatusChip, type Status } from "../ui/index";
import type { Store } from "../store";
import type { FeishuChannelStatus, FeishuMeshChatEnsureResult, FeishuProvisionJobPublic } from "../../types";
import { useI18n, type TFn } from "../i18n";

function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<unknown>) => { setBusy(true); try { await p; } catch { /* store toasts */ } finally { setBusy(false); } };
  return { busy, run };
}

function statusChip(status: FeishuChannelStatus | null, t: TFn): { tone: Status; label: string } {
  if (!status || !status.configured) return { tone: "idle", label: t("bnw.ch.notConfigured") };
  if (status.state === "error") return { tone: "blocked", label: t("bnw.ch.configInvalid") };
  if (status.state === "running") return { tone: "ready", label: t("bnw.ch.runningGroups", { n: status.bindings?.length ?? 0 }) };
  if (status.enabled) return { tone: "working", label: status.state };
  return { tone: "idle", label: t("bnw.ch.disabled") };
}

export function BnwChannels({ store }: { store: Store }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<FeishuChannelStatus | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "offline">("loading");
  const [job, setJob] = useState<FeishuProvisionJobPublic | null>(null);
  const [results, setResults] = useState<Record<string, FeishuMeshChatEnsureResult>>({});
  const sync = useBusy();

  async function load() {
    try {
      const s = await store.getFeishuStatus();
      setStatus(s); setPhase("ready");
    } catch (e) {
      // 404 "feishu channel is not available" → simply not configured (render the empty status card).
      if (/not available|404/i.test(String((e as Error)?.message ?? e))) { setStatus(null); setPhase("ready"); }
      else setPhase(status ? "offline" : "error");
    }
  }
  // mount-only initial fetch (store ref is stable for the component's life).
  useEffect(() => { void load(); }, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll an in-flight provision job until it settles, then refresh status (a new binding/group).
  const provisioning = !!job && (job.state === "starting" || job.state === "waiting");
  useEffect(() => {
    if (!provisioning || !job) return;
    const t = setInterval(async () => {
      try {
        const next = await store.getFeishuProvision(job.id);
        setJob(next);
        if (next.state === "complete") void load();
      } catch { /* transient */ }
    }, 1500);
    return () => clearInterval(t);
  }, [provisioning, job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const offline = phase === "offline";
  const disabled = offline;

  async function startProvision() {
    try { setJob(await store.startFeishuProvision({ enable: true, autoCreateMeshChats: true })); } catch { /* store toasts */ }
  }
  async function cancelProvision() {
    if (!job) return;
    try { setJob(await store.cancelFeishuProvision(job.id)); } catch { /* store toasts */ }
  }
  async function syncAll() {
    await sync.run((async () => { const rows = await store.syncFeishuMeshChats(); setResults((r) => ({ ...r, ...Object.fromEntries(rows.map((x) => [x.mesh, x])) })); await load(); })());
  }
  async function ensureGroup(mesh: string) {
    try { const r = await store.ensureFeishuMeshChat(mesh); setResults((cur) => ({ ...cur, [mesh]: r })); await load(); } catch { /* store toasts */ }
  }

  const actions = <Button size="sm" variant="ghost" disabled={offline} aria-label="refresh channel status" onClick={() => void load()}>{t("bnw.refresh")}</Button>;

  return (
    <PanelFrame title="Channels" actions={actions} className="h-full" bodyClassName="min-h-0">
      <div data-channels="panel" className="flex min-h-0 flex-col">
        {/* 7.5-C — offline/reconnect is now the unified shell-level banner (BnwApp); controls
            below stay disabled via `offline` independently. */}
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
          {phase === "loading" ? (
            <div className="flex flex-col gap-3"><Skeleton variant="line" /><Skeleton variant="row" /><Skeleton variant="card" /></div>
          ) : phase === "error" ? (
            <ErrorBanner title={t("bnw.ch.probeFailed")} onRetry={() => void load()}>{t("bnw.ch.probeFailedDesc")}</ErrorBanner>
          ) : (
            <>
              <ChannelStatusCard status={status} />
              {/* bindings (chat↔mesh + provision) — desktop operator surface (mobile defers per mockup) */}
              <div className="hidden lg:block">
                <ChannelBindingsCard status={status} disabled={disabled} busy={sync.busy} job={job} results={results}
                  onSync={() => void syncAll()} onBind={() => void startProvision()} onCancel={() => void cancelProvision()} onEnsure={(m) => void ensureGroup(m)} />
              </div>
              <PendingSendersPlaceholder />
              <div className="hidden lg:block"><AuthorizedSendersPlaceholder /></div>
              <p className="text-xs text-text-muted lg:hidden">{t("bnw.ch.mobileNote")}</p>
            </>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}

export function ChannelStatusCard({ status }: { status: FeishuChannelStatus | null }) {
  const { t } = useI18n();
  const s = statusChip(status, t);
  const configured = !!status?.configured;
  return (
    <div data-channel-status className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-text-primary">{t("bnw.ch.feishu")}</span>
        <StatusChip status={s.tone} variant="soft" label={s.label} />
        {status?.domain ? <StatusChip status="idle" variant="soft" label={`domain: ${status.domain}`} /> : null}
        <span className="flex-1" aria-hidden="true" />
        {status?.configPath ? <code className="truncate font-mono text-xs text-text-muted">{status.configPath}</code> : null}
      </div>
      {!configured
        ? <p className="text-xs text-text-muted">{t("bnw.ch.notConfiguredPre")} <code className="font-mono">channels/feishu.json</code>{t("bnw.ch.notConfiguredPost")}</p>
        : status?.state === "error"
          ? <p className="text-xs text-danger">{t("bnw.ch.configInvalidPre")}{status.reason ?? t("bnw.ch.configInvalidReason")}{t("bnw.ch.configInvalidPost")}</p>
          : <p className="text-xs text-text-muted">{status?.appId ? `appId ${status.appId} · ` : ""}{t("bnw.ch.configuredNote")}</p>}
    </div>
  );
}

export function ChannelBindingsCard({ status, disabled = false, busy = false, job, results, onSync, onBind, onCancel, onEnsure }: {
  status: FeishuChannelStatus | null; disabled?: boolean; busy?: boolean; job: FeishuProvisionJobPublic | null;
  results: Record<string, FeishuMeshChatEnsureResult>; onSync: () => void; onBind: () => void; onCancel: () => void; onEnsure: (mesh: string) => void;
}) {
  const { t } = useI18n();
  const bindings = status?.bindings ?? [];
  const provisioning = !!job && (job.state === "starting" || job.state === "waiting");
  return (
    <div data-bindings className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-text-muted">{t("bnw.ch.bindings", { n: bindings.length })}</span>
        <Cluster>
          <Button size="sm" variant="ghost" disabled={disabled || busy} busy={busy} aria-label="sync feishu groups" onClick={onSync}>{t("bnw.ch.sync")}</Button>
          <Button size="sm" variant="secondary" disabled={disabled || provisioning} aria-label="bind chat to mesh" onClick={onBind}>{t("bnw.ch.bind")}</Button>
        </Cluster>
      </div>
      {job && job.state === "error" ? <ErrorBanner title={t("bnw.ch.bindFailed")}>{job.error ?? t("bnw.ch.provisionFailed")}</ErrorBanner> : null}
      {provisioning ? <ProvisionCard job={job!} disabled={disabled} onCancel={onCancel} /> : null}
      {bindings.length === 0 && !provisioning ? <span className="text-xs text-text-muted">{t("bnw.ch.noBindings")}</span> : (
        <div className="flex flex-col gap-1.5">
          {bindings.map((b) => {
            const r = results[b.mesh];
            return (
              <div key={b.mesh} data-binding className="flex flex-wrap items-center gap-2 text-sm">
                <StatusChip status={r && r.ok === false ? "blocked" : "ready"} variant="dot" />
                <span className="font-medium text-text-primary">{b.mesh}</span>
                <span aria-hidden="true" className="text-text-muted">←</span>
                <code className="font-mono text-xs text-text-muted">{b.chatId}</code>
                {b.name ? <span className="text-xs text-text-muted">{b.name}</span> : null}
                {b.source ? <StatusChip status="idle" variant="soft" label={b.source} /> : null}
                {b.requireMention ? <span className="text-xs text-text-muted">@mention</span> : null}
                {r?.error ? <span className="text-xs text-danger">{r.error}</span> : null}
                <span className="flex-1" aria-hidden="true" />
                <Button size="sm" variant="ghost" disabled={disabled} aria-label={`ensure group ${b.mesh}`} onClick={() => onEnsure(b.mesh)}>{t("bnw.ch.ensureGroup")}</Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ProvisionCard({ job, disabled = false, onCancel }: { job: FeishuProvisionJobPublic; disabled?: boolean; onCancel: () => void }) {
  const { t } = useI18n();
  const expiry = job.expireIn !== undefined ? t("bnw.ch.expiry", { t: `${Math.max(0, Math.floor(job.expireIn / 60))}:${String(Math.max(0, job.expireIn % 60)).padStart(2, "0")}` }) : "";
  return (
    <div data-provision className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3">
      {job.qrCodeDataUrl
        ? <img src={job.qrCodeDataUrl} alt={t("bnw.ch.qrAlt")} className="h-20 w-20 shrink-0 rounded border border-border-strong bg-surface" />
        : <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded border border-border-strong bg-surface text-3xl" aria-label={t("bnw.ch.qrAria")}><Spinner size={20} label="generating QR" /></div>}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm text-text-primary">{t("bnw.ch.scanToAuth", { state: job.state })}</span>
        {job.verificationUrl ? <a href={job.verificationUrl} target="_blank" rel="noreferrer" className="truncate text-xs text-link">{job.verificationUrl}</a> : null}
        <span className="text-xs text-text-muted">{expiry}{t("bnw.ch.polling")}</span>
      </div>
      <Button size="sm" variant="ghost" disabled={disabled} aria-label="cancel provision" onClick={onCancel}>{t("cancel")}</Button>
    </div>
  );
}

// Security-driven placeholders (Option B): sender auth admin is host-CLI authoritative; no web actions.
export function PendingSendersPlaceholder() {
  const { t } = useI18n();
  return (
    <div data-pending-senders className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">{t("bnw.ch.pendingSenders")}</span>
      <p className="text-xs text-text-muted">{t("bnw.ch.pendingNotePre")}<code className="font-mono">mesh channels feishu list | approve &lt;code&gt; | revoke &lt;channelKey&gt; &lt;openId&gt;</code>{t("bnw.ch.pendingNotePost")}</p>
    </div>
  );
}
export function AuthorizedSendersPlaceholder() {
  const { t } = useI18n();
  return (
    <div data-authorized-senders className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">{t("bnw.ch.authorizedSenders")}</span>
      <p className="text-xs text-text-muted">{t("bnw.ch.authNotePre")}<code className="font-mono">mesh channels feishu list</code>{t("bnw.ch.authNoteMid")}<code className="font-mono">revoke</code>{t("bnw.ch.authNotePost")}</p>
    </div>
  );
}
