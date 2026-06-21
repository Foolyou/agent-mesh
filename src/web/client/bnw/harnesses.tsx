// Step 7.4-A.2a — Harnesses surface (mockup 06): adapter install/health/version + old-version
// agent restarts. Independent /bnw view tree; shares the data layer only (store.listHarnesses /
// installHarness / streamHarnessInstall / reprobeHarness / respawnAgent — never importing the old
// HarnessPanel). The status/version derivation mirrors HarnessPanel.tsx (kept local so no server
// harness logic enters the bundle). Parity #26 (install live-log+retry+close) / #27 (self-install
// guide) / #28 (restart force/after-idle/cancel).
import { useEffect, useRef, useState } from "react";
import { Button, ConfirmButton, ErrorBanner, PanelFrame, Skeleton, Spinner, StatusChip, type Status } from "../ui/index";
import type { Store } from "../store";
import type { HarnessId, HarnessInstallEvent, HarnessProbeRow } from "../../types";

const HARNESS_ORDER: HarnessId[] = ["claude", "codex", "opencode", "kimi"];
const HARNESS_COMMANDS: Record<HarnessId, { adapter: string; tool?: string }> = {
  claude: { adapter: "claude-agent-acp", tool: "claude" },
  codex: { adapter: "codex-acp", tool: "codex" },
  opencode: { adapter: "opencode" },
  kimi: { adapter: "kimi" },
};
type HarnessKind = "ok" | "warn" | "bad" | "off";
const HARNESS_TONE: Record<HarnessKind, Status> = { ok: "ready", warn: "attention", bad: "blocked", off: "idle" };

/** Compact dual-version label, e.g. "codex-acp 1.2.3 · codex 0.140.0" (mirrors HarnessPanel). */
function harnessVersionLine(row: HarnessProbeRow): string {
  const cmd = HARNESS_COMMANDS[row.id];
  const adapter = `${cmd.adapter} ${row.version ?? "—"}`;
  return cmd.tool ? `${adapter} · ${cmd.tool} ${row.toolVersion ?? "—"}` : adapter;
}
function statusLabel(row: HarnessProbeRow): { text: string; kind: HarnessKind } {
  if (!row.installed) return { text: "missing — install required", kind: "bad" };
  if (row.error === "registry-unavailable" || !row.latest) return { text: "version comparison unavailable", kind: "off" };
  if (row.outdated && row.version) return { text: `update available — v${row.version} → v${row.latest}`, kind: "warn" };
  if (row.version) return { text: `installed v${row.version}`, kind: "ok" };
  return { text: "installed; version unknown", kind: "off" };
}

interface InstallState { harness: HarnessId; pkgSpec: string; status: "running" | "done" | "error" | "interrupted"; liveText: string; lines: string[] }

export function BnwHarnesses({ store }: { store: Store }) {
  const [rows, setRows] = useState<HarnessProbeRow[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "offline">("loading");
  const [install, setInstall] = useState<InstallState | null>(null);
  const lastLineAt = useRef(0);

  async function load() {
    if (!rows.length) setPhase("loading");
    try { setRows(await store.listHarnesses()); setPhase("ready"); }
    catch { setPhase(rows.length ? "offline" : "error"); }
  }
  // mount-only initial probe (store ref is stable for the component's life).
  useEffect(() => { void load(); }, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyInstallEvent(event: HarnessInstallEvent, label: string) {
    const line = event.stdoutLine ?? event.stderrLine;
    setInstall((cur) => {
      if (!cur) return cur;
      const nextLines = line && Date.now() - lastLineAt.current > 220 ? [...cur.lines.slice(-80), line] : cur.lines;
      if (line && nextLines !== cur.lines) lastLineAt.current = Date.now();
      if (event.step === "done") return { ...cur, status: "done", liveText: `Installed ${event.installedVersion ? `v${event.installedVersion}` : label}`, lines: nextLines };
      if (event.step === "error") return { ...cur, status: "error", liveText: event.message ?? "install failed", lines: nextLines };
      const pct = event.progress !== undefined ? ` ${event.progress}%` : "";
      return { ...cur, liveText: `${event.step} ${label}${pct}`, lines: nextLines };
    });
  }
  async function startInstall(row: HarnessProbeRow) {
    try {
      const job = await store.installHarness(row.id);
      setInstall({ harness: row.id, pkgSpec: job.pkgSpec, status: "running", liveText: `Installing ${row.label}`, lines: [] });
      await store.streamHarnessInstall(row.id, job.jobId, (e) => applyInstallEvent(e, row.label), (err) => {
        if (err) setInstall((cur) => (cur && cur.status === "running" ? { ...cur, status: "interrupted", liveText: "stream interrupted, click to retry" } : cur));
      }).catch(() => {});
      void load(); // refresh versions once the stream settles (harness-changed)
    } catch { /* store toasts */ }
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const offline = phase === "offline";
  const oldAgents = rows.flatMap((r) => r.runningAgentsUsingOldVersion.map((entry) => ({ harnessId: r.id, target: r.latest ?? r.version, entry })));

  const actions = <Button size="sm" variant="ghost" disabled={offline} aria-label="refresh harness status" onClick={() => void load()}>refresh</Button>;

  return (
    <PanelFrame title="Harnesses" actions={actions} className="h-full" bodyClassName="min-h-0">
      <div data-harnesses="panel" className="flex min-h-0 flex-col">
        {/* 7.5-C — offline/reconnect is now the unified shell-level banner (BnwApp); install/
            restart stay disabled via `offline` independently. */}
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
          {phase === "loading" ? (
            <div className="flex flex-col rounded-lg border border-border bg-surface-raised">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="border-b border-border px-3 py-2.5 last:border-0">
                  <div className="flex items-center gap-2"><StatusChip status="idle" variant="dot" /><span className="text-sm text-text-muted">loading status…</span></div>
                  <div className="mt-1"><Skeleton variant="line" /></div>
                </div>
              ))}
            </div>
          ) : phase === "error" ? (
            <ErrorBanner title="Probe failed" onRetry={() => void load()}>无法探测 harness — 注册表不可达；重试。</ErrorBanner>
          ) : (
            <>
              <div className="flex flex-col rounded-lg border border-border bg-surface-raised">
                {HARNESS_ORDER.map((id) => {
                  const row = byId.get(id);
                  return row
                    ? <HarnessRow key={id} row={row} disabled={offline} onReprobe={() => void store.reprobeHarness(id).then(load)} onInstall={() => void startInstall(row)} />
                    : <div key={id} className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-sm text-text-muted last:border-0"><StatusChip status="idle" variant="dot" /> {id}</div>;
                })}
              </div>
              {install ? <InstallProgressCard install={install} onRetry={() => { const r = byId.get(install.harness); if (r) void startInstall(r); }} onClose={() => setInstall(null)} /> : null}
              {oldAgents.length ? <OldVersionAgentsCard agents={oldAgents} store={store} disabled={offline} /> : null}
            </>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}

export function HarnessRow({ row, disabled = false, onReprobe, onInstall }: { row: HarnessProbeRow; disabled?: boolean; onReprobe: () => void; onInstall: () => void }) {
  const status = statusLabel(row);
  const self = row.installable === "self" ? row.installHint : undefined;
  const line = row.installed ? harnessVersionLine(row) : (self?.docsUrl ?? row.path ?? "not detected on PATH");
  const canInstall = !self && (status.kind === "bad" || status.kind === "warn");
  return (
    <div data-harness-row className="flex flex-col gap-1 border-b border-border px-3 py-2.5 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={HARNESS_TONE[status.kind]} variant="dot" />
        <span className="text-sm font-medium text-text-primary">{row.label}</span>
        <StatusChip status={HARNESS_TONE[status.kind]} variant="soft" label={status.text} />
        {row.auth === "required" ? <StatusChip status="attention" variant="soft" label="auth required" /> : null}
        <span className="flex-1" aria-hidden="true" />
        {/* Deviation from mockup 06: self-install rows expose reprobe only inside the guide (old real
            behavior) to avoid a duplicate reprobe control + aria-label the mockup renders. */}
        {self ? null : <Button size="sm" variant="ghost" disabled={disabled} aria-label={`reprobe ${row.id}`} className="whitespace-nowrap" onClick={onReprobe}>reprobe</Button>}
        {canInstall ? <Button size="sm" variant="secondary" disabled={disabled || row.installable !== "npm"} aria-label={`${status.kind === "warn" ? "update" : "install"} ${row.id}`} className="whitespace-nowrap" onClick={onInstall}>{status.kind === "warn" ? "update" : "install"}</Button> : null}
      </div>
      <div className="truncate font-mono text-xs text-text-muted">{line}</div>
      {self ? <SelfInstallerGuide id={row.id} command={self.command} docsUrl={self.docsUrl} disabled={disabled} onReprobe={onReprobe} /> : null}
    </div>
  );
}

export function SelfInstallerGuide({ id, command, docsUrl, disabled = false, onReprobe }: { id: string; command: string; docsUrl: string; disabled?: boolean; onReprobe: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div data-self-installer className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-xs">
      <span className="text-text-muted">自助安装：</span>
      <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-text-secondary">{command}</code>
      <Button size="sm" variant="ghost" disabled={disabled} aria-label={`copy install command for ${id}`} className="whitespace-nowrap"
        onClick={async () => { try { await navigator.clipboard?.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard unavailable */ } }}>{copied ? "copied" : "copy command"}</Button>
      <a className="rounded-lg px-2 py-1 text-link underline-offset-2 hover:underline" href={docsUrl} target="_blank" rel="noreferrer" aria-label={`open ${id} docs`}>docs ↗</a>
      <Button size="sm" variant="ghost" disabled={disabled} aria-label={`reprobe to detect ${id}`} className="whitespace-nowrap" onClick={onReprobe}>reprobe to detect</Button>
    </div>
  );
}

export function InstallProgressCard({ install, onRetry, onClose }: { install: InstallState; onRetry: () => void; onClose: () => void }) {
  const tone: Status = install.status === "running" ? "working" : install.status === "done" ? "done" : install.status === "interrupted" ? "attention" : "blocked";
  return (
    <div data-install-progress className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={tone} variant="dot" />
        <span className="text-sm text-text-primary" aria-live="polite">{install.liveText}</span>
        <span className="flex-1" aria-hidden="true" />
        {install.status === "running" ? <Spinner size={12} label="installing" /> : null}
        {install.status === "interrupted" ? <Button size="sm" variant="primary" aria-label="retry stream" onClick={onRetry}>retry stream</Button> : null}
        {install.status !== "running" ? <Button size="sm" variant="ghost" aria-label="close install progress" onClick={onClose}>close</Button> : null}
      </div>
      <pre className="max-h-40 overflow-auto rounded bg-surface px-2 py-1.5 font-mono text-xs text-text-secondary">{install.lines.join("\n") || install.pkgSpec}</pre>
    </div>
  );
}

interface OldAgentEntry { harnessId: HarnessId; target?: string; entry: string }
export function OldVersionAgentsCard({ agents, store, disabled = false }: { agents: OldAgentEntry[]; store: Store; disabled?: boolean }) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const setEntryPending = (entry: string, on: boolean) => setPending((cur) => { const next = new Set(cur); if (on) next.add(entry); else next.delete(entry); return next; });
  const respawn = (entry: string, mode: "after-idle" | "force" | "cancel") => {
    const slash = entry.indexOf("/");
    const mesh = slash >= 0 ? entry.slice(0, slash) : entry;
    const agent = slash >= 0 ? entry.slice(slash + 1) : entry;
    void store.respawnAgent(mesh, agent, mode).then(() => setEntryPending(entry, mode === "after-idle")).catch(() => {});
  };
  return (
    <div data-old-agents className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">旧版本 agent · 重启以采用新适配器 ({agents.length})</span>
      <div className="flex flex-col gap-1.5">
        {agents.map((a) => {
          const isPending = pending.has(a.entry);
          return (
            <div key={a.entry} data-old-agent className="flex flex-wrap items-center gap-2 border-b border-border pb-1.5 text-sm last:border-0">
              <StatusChip status={isPending ? "working" : "attention"} variant="dot" />
              <span className="font-medium text-text-primary">{a.entry}</span>
              <span className="font-mono text-xs text-text-muted">running an older {a.harnessId}{a.target ? ` → v${a.target}` : ""}</span>
              <span className="flex-1" aria-hidden="true" />
              {isPending ? (
                <>
                  <span className="text-xs text-text-muted">restart pending…</span>
                  <Button size="sm" variant="ghost" disabled={disabled} aria-label={`cancel restart ${a.entry}`} className="whitespace-nowrap" onClick={() => respawn(a.entry, "cancel")}>cancel</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="secondary" disabled={disabled} aria-label={`restart ${a.entry} after idle`} className="whitespace-nowrap" onClick={() => respawn(a.entry, "after-idle")}>after current turn</Button>
                  <ConfirmButton size="sm" variant="danger" disabled={disabled} aria-label={`force restart ${a.entry}`} confirmLabel="确认?（丢失 ACP 会话）" className="whitespace-nowrap" onConfirm={() => respawn(a.entry, "force")}>force</ConfirmButton>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
