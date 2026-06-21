// Step 7.4-A — Doctor / system surface (mockup 08): health checks + mesh-host daemons + leak
// recovery. Independent /bnw view tree; shares the DATA layer only (store.fetchDoctor /
// fetchPsDetail / reapLeaks / restartDaemon — never importing the old SystemPanel). The
// diagnostics model (DoctorReport / PsDetail) is type-only shared, so no node:fs runtime is
// pulled into the bundle; the copy-text is rendered inline rather than via diagnostics' renderer.
import { useEffect, useState } from "react";
import { Button, ErrorBanner, PanelFrame, Skeleton, Spinner, StatusChip, type Status } from "../ui/index";
import type { Store } from "../store";
import type { DoctorReport, GatewayState, MeshProcDetail, ProcLeak, PsDetail, Severity } from "../../types";

const SEV_TONE: Record<Severity, Status> = { ok: "ready", info: "idle", warning: "attention", error: "blocked" };
type Phase = "loading" | "ready" | "error" | "offline";

function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<unknown>) => { setBusy(true); try { await p; } catch { /* store toasts */ } finally { setBusy(false); } };
  return { busy, run };
}

function fmtUptime(startedAt?: string): string {
  if (!startedAt) return "—";
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function buildCopyText(report: DoctorReport | null, ps: PsDetail | null): string {
  const lines: string[] = [];
  if (report) {
    const s = report.summary;
    lines.push(`doctor: worst ${s.worst} · ${s.ok} ok · ${s.warnings} warn · ${s.errors} error · ${s.total} total`);
    for (const c of report.checks) lines.push(`  [${c.severity}] ${c.id}: ${c.detail}${c.fixHint ? ` (↳ ${c.fixHint})` : ""}`);
  }
  if (ps) {
    lines.push(`daemons (${ps.running.length}):`);
    for (const d of ps.running) lines.push(`  ${d.name}\tpid ${d.pid}\t${d.agents.length} agents\t${d.socketPath}`);
    if (ps.leaks.length) {
      lines.push(`leaks (${ps.leaks.length}):`);
      for (const l of ps.leaks) lines.push(`  ${l.name}\t${l.kind}\t${l.detail}`);
    }
  }
  return lines.join("\n");
}

export function BnwDoctor({ store, state }: { store: Store; state: GatewayState }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [ps, setPs] = useState<PsDetail | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [running, setRunning] = useState(false);
  const reap = useBusy();

  async function load(mode: "initial" | "run") {
    if (mode === "run") setRunning(true); else if (!report && !ps) setPhase("loading");
    try {
      const [d, p] = await Promise.all([store.fetchDoctor(), store.fetchPsDetail()]);
      setReport(d); setPs(p); setPhase("ready");
    } catch {
      // keep last-known data when we have it (backend down → offline); otherwise hard error.
      setPhase(report || ps ? "offline" : "error");
    } finally {
      setRunning(false);
    }
  }
  // mount-only initial fetch (store ref is stable for the component's life).
  useEffect(() => { void load("initial"); }, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  const offline = phase === "offline";
  const disabled = offline;

  async function copyDiagnostics() {
    const text = buildCopyText(report, ps);
    try { await navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
  }
  async function reapLeak(names?: string[]) {
    await reap.run((async () => { const r = await store.reapLeaks(names); setPs(r.ps); })());
  }

  const actions = (
    <Button size="sm" variant="ghost" disabled={disabled} aria-label="refresh diagnostics" onClick={() => void load("run")}>refresh</Button>
  );

  return (
    <PanelFrame title="Doctor / 系统" actions={actions} className="h-full" bodyClassName="min-h-0">
      <div data-doctor="panel" className="flex min-h-0 flex-col">
        {offline ? (
          <div role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-danger-subtle px-3 py-1.5 text-xs text-danger">
            <Spinner size={12} label="reconnecting" /> 服务不可达 — 显示最近已知诊断，恢复操作禁用。
          </div>
        ) : null}
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
          {phase === "loading" ? (
            <div className="flex flex-col gap-3"><Skeleton variant="line" /><Skeleton variant="row" /><Skeleton variant="card" /></div>
          ) : phase === "error" ? (
            <ErrorBanner title="Doctor probe failed" onRetry={() => void load("run")}>诊断请求失败 — backend 仍在线则可重试。</ErrorBanner>
          ) : (
            <>
              <DoctorSummary report={report} appVersion={state.appVersion} offline={offline} running={running}
                onRun={() => void load("run")} onCopy={() => void copyDiagnostics()} />
              <DoctorFindings report={report} />
              <DaemonTable ps={ps} disabled={disabled} onRestart={(n) => void store.restartDaemon(n)} />
              <DoctorRecovery ps={ps} disabled={disabled} busy={reap.busy} onReap={reapLeak} />
            </>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}

export function DoctorSummary({ report, appVersion, offline, running, onRun, onCopy }: {
  report: DoctorReport | null; appVersion?: string; offline: boolean; running: boolean; onRun: () => void; onCopy: () => void;
}) {
  const s = report?.summary ?? { total: 0, ok: 0, warnings: 0, errors: 0, worst: "ok" as Severity };
  return (
    <div data-doctor-summary className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-raised p-3">
      <StatusChip status={SEV_TONE[s.worst]} variant="soft" label={`worst: ${s.worst}`} />
      <span className="text-xs text-text-muted">{s.ok} ok · {s.warnings} warn · {s.errors} error · {s.total} 总计</span>
      <span className="text-xs text-text-muted">· agent-mesh {appVersion ?? "dev"}{offline ? "（cached）" : ""}</span>
      <span className="flex-1" aria-hidden="true" />
      <Button size="sm" variant="ghost" disabled={offline} aria-label="copy diagnostics" onClick={onCopy}>copy 诊断</Button>
      <Button size="sm" variant="secondary" disabled={offline} busy={running} aria-label="run doctor" onClick={onRun}>{running ? "running…" : "run doctor"}</Button>
    </div>
  );
}

export function DoctorFindings({ report }: { report: DoctorReport | null }) {
  const checks = report?.checks ?? [];
  return (
    <div data-doctor-findings className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">doctor findings ({checks.length})</span>
      {checks.length === 0 ? <span className="text-xs text-text-muted">no findings.</span> : checks.map((c) => (
        <div key={c.id} className="flex flex-col gap-0.5 border-b border-border py-1.5 last:border-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={SEV_TONE[c.severity]} variant="dot" />
            <code className="font-mono text-xs text-text-secondary">{c.id}</code>
            <StatusChip status={SEV_TONE[c.severity]} variant="soft" label={c.severity} />
            <span className="min-w-0 flex-1 text-sm text-text-primary">{c.detail}</span>
          </div>
          {c.fixHint ? <span className="pl-6 text-xs text-text-muted">↳ {c.fixHint}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function DaemonTable({ ps, disabled, onRestart }: { ps: PsDetail | null; disabled: boolean; onRestart: (name: string) => void }) {
  const daemons: MeshProcDetail[] = ps?.running ?? [];
  return (
    <div data-daemons className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs uppercase tracking-wider text-text-muted">mesh-host daemons · ps ({daemons.length})</span>
      {daemons.length === 0 ? <span className="text-xs text-text-muted">none running.</span> : daemons.map((d) => (
        <div key={d.name} className="flex flex-wrap items-center gap-2 border-b border-border py-1.5 text-sm last:border-0">
          <StatusChip status="working" variant="dot" />
          <span className="font-medium text-text-primary">{d.name}</span>
          <span className="font-mono text-xs text-text-muted">pid {d.pid} · up {fmtUptime(d.startedAt)} · {d.agents.length} agents</span>
          <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-text-muted lg:block">{d.socketPath}</span>
          <span className="flex-1 lg:hidden" aria-hidden="true" />
          <Button size="sm" variant="ghost" className="hidden lg:inline-flex" disabled={disabled} aria-label={`restart daemon ${d.name}`} onClick={() => onRestart(d.name)}>restart</Button>
        </div>
      ))}
    </div>
  );
}

export function DoctorRecovery({ ps, disabled, busy, onReap }: { ps: PsDetail | null; disabled: boolean; busy: boolean; onReap: (names?: string[]) => void }) {
  const leaks: ProcLeak[] = ps?.leaks ?? [];
  return (
    <>
      {/* Recovery (reap orphan/stale leaks) is an operator/desktop action — deferred to CLI on mobile. */}
      <div data-recovery className="hidden flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3 lg:flex">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wider text-text-muted">恢复 · 孤儿/僵尸进程 ({leaks.length})</span>
          <Button size="sm" variant="secondary" disabled={disabled || leaks.length === 0} busy={busy} aria-label="reap all orphans" onClick={() => onReap()}>reap all</Button>
        </div>
        {leaks.length === 0 ? (
          <span className="text-xs text-text-muted">无孤儿/僵尸进程。</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {leaks.map((l) => (
              <div key={l.name} data-leak className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm">
                <StatusChip status={l.kind === "orphan_socket" ? "attention" : "blocked"} variant="dot" />
                <span className="font-medium text-text-primary">{l.name}</span>
                <StatusChip status="idle" variant="soft" label={l.kind} />
                <span className="min-w-0 flex-1 text-xs text-text-muted">{l.detail}</span>
                {busy ? <Spinner size={12} label="reaping" /> : null}
                <Button size="sm" variant="ghost" disabled={disabled} aria-label={`reap ${l.name}`} onClick={() => onReap([l.name])}>reap</Button>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-text-muted lg:hidden">恢复操作（reap / restart daemon）在桌面端或 CLI 执行。</p>
    </>
  );
}
