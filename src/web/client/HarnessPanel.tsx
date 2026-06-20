import { useEffect, useMemo, useRef, useState } from "react";
import type { Store } from "./store";
import type { HarnessId, HarnessInstallEvent, HarnessProbeRow } from "../types";
import { Btn, ConfirmButton } from "./ui";

const HARNESS_ORDER: HarnessId[] = ["claude", "codex", "opencode", "kimi"];

// Command names for the compact dual-version line. `tool` is the underlying body CLI shown alongside
// the ACP adapter (codex-acp · codex, claude-agent-acp · claude); opencode/kimi launch the tool
// directly so have a single command. Mirrors src/harness.ts HARNESSES (kept local to avoid pulling
// server harness logic into the client bundle).
const HARNESS_COMMANDS: Record<HarnessId, { adapter: string; tool?: string }> = {
  claude: { adapter: "claude-agent-acp", tool: "claude" },
  codex: { adapter: "codex-acp", tool: "codex" },
  opencode: { adapter: "opencode" },
  kimi: { adapter: "kimi" },
};

/** Compact dual-version label, e.g. "codex-acp 1.2.3 · codex 0.141.0". Adapter version comes from
 *  the ACP probe; the body tool is display-only. Unknown versions render as "—". */
export function harnessVersionLine(row: HarnessProbeRow): string {
  const cmd = HARNESS_COMMANDS[row.id];
  const adapter = `${cmd.adapter} ${row.version ?? "—"}`;
  return cmd.tool ? `${adapter} · ${cmd.tool} ${row.toolVersion ?? "—"}` : adapter;
}

interface InstallState {
  harness: HarnessId;
  pkgSpec: string;
  status: "running" | "done" | "error" | "interrupted";
  liveText: string;
  lines: string[];
}

export function HarnessPanel({ store, open, onClose }: { store: Store; open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<HarnessProbeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [install, setInstall] = useState<InstallState | null>(null);
  const lastLineAt = useRef(0);

  const refresh = async () => {
    setLoading(true);
    try {
      setRows(await store.listHarnesses());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
    return store.subscribe(() => {
      if (open) void refresh();
    });
  }, [open]);

  async function startInstall(row: HarnessProbeRow) {
    const job = await store.installHarness(row.id);
    setInstall({ harness: row.id, pkgSpec: job.pkgSpec, status: "running", liveText: `Installing ${row.label}`, lines: [] });
    await store.streamHarnessInstall(
      row.id,
      job.jobId,
      (event) => applyInstallEvent(event, row),
      (err) => {
        if (err) setInstall((cur) => cur && cur.status === "running" ? { ...cur, status: "interrupted", liveText: "stream interrupted, click to retry" } : cur);
      },
    ).catch(() => {});
  }

  function applyInstallEvent(event: HarnessInstallEvent, row: HarnessProbeRow) {
    const line = event.stdoutLine ?? event.stderrLine;
    setInstall((cur) => {
      if (!cur) return cur;
      const nextLines = line && Date.now() - lastLineAt.current > 220
        ? [...cur.lines.slice(-80), line]
        : cur.lines;
      if (line && nextLines !== cur.lines) lastLineAt.current = Date.now();
      if (event.step === "done") {
        return { ...cur, status: "done", liveText: `Installed ${event.installedVersion ? `v${event.installedVersion}` : row.label}`, lines: nextLines };
      }
      if (event.step === "error") {
        return { ...cur, status: "error", liveText: event.message ?? "install failed", lines: nextLines };
      }
      const pct = event.progress !== undefined ? ` ${event.progress}%` : "";
      return { ...cur, liveText: `${event.step} ${row.label}${pct}`, lines: nextLines };
    });
  }

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  if (!open) return null;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal harness-modal" role="dialog" aria-modal="true" aria-label="Harness settings" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <span>Harness settings</span>
          <span className="spacer" />
          <Btn small kind="ghost" onClick={() => void refresh()} ariaLabel="Refresh harness status">refresh</Btn>
          <Btn small kind="ghost" onClick={onClose} ariaLabel="Close harness settings">close</Btn>
        </div>
        <div className="mbody">
          <div className="harness-grid" aria-busy={loading}>
            {HARNESS_ORDER.map((id) => {
              const row = byId.get(id);
              return row ? <HarnessRow key={id} row={row} store={store} onInstall={() => void startInstall(row)} onReprobe={() => void store.reprobeHarness(row.id).then(refresh)} /> : (
                <div className="harness-row" key={id}>
                  <span className="harness-name">{id}</span>
                  <span className="harness-badge off">loading status</span>
                </div>
              );
            })}
          </div>
          {install ? (
            <InstallProgress install={install} onRetry={() => {
              const row = byId.get(install.harness);
              if (row) void startInstall(row);
            }} onClose={() => setInstall(null)} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function HarnessRow({ row, onInstall, onReprobe, store }: { row: HarnessProbeRow; onInstall: () => void; onReprobe: () => void; store?: Store }) {
  const status = statusLabel(row);
  const installHint = row.installable === "self" ? row.installHint : undefined;
  const installDisabled = row.installable !== "npm";
  const descId = `harness-${row.id}-install-desc`;
  const actionLabel = row.installed && row.outdated && row.version && row.latest
    ? `Update ${row.id} from ${row.version} to ${row.latest}`
    : `Install ${row.id} (not detected on this host)`;
  return (
    <div className="harness-row">
      <div>
        <div className="harness-name">{row.label}</div>
        {row.installed ? <div className="harness-versions">{harnessVersionLine(row)}</div> : null}
        <div className="harness-meta">{row.path ?? row.installHint?.docsUrl ?? "not detected on PATH"}</div>
      </div>
      <span className={`harness-badge ${status.kind}`}>{status.text}</span>
      {row.auth === "required" ? <span className="harness-badge warn">auth required</span> : null}
      <span className="harness-actions">
        {installHint ? null : <Btn small kind="ghost" onClick={onReprobe} ariaLabel={`Reprobe ${row.id}`}>reprobe</Btn>}
        {installHint ? null : (
          <Btn small kind="go" disabled={installDisabled} ariaLabel={actionLabel} ariaDescribedBy={installDisabled ? descId : undefined} onClick={onInstall}>
            {row.installed ? "update" : "install"}
          </Btn>
        )}
      </span>
      {installHint ? <SelfInstallerGuide row={row} command={installHint.command} docsUrl={installHint.docsUrl} onReprobe={onReprobe} /> : null}
      {installDisabled && !installHint ? <span id={descId} className="harness-desc">Use the copy command flow for self-installing harnesses; click docs from the self-installer guide.</span> : null}
      {store && row.runningAgentsUsingOldVersion.length ? <OldVersionAgents row={row} store={store} /> : null}
    </div>
  );
}

// Agents still running an older adapter version — restart them to adopt the newer one. Lives on the
// harness list page only (the conversation-area note was removed). Reuses the existing per-agent
// respawn API (after-idle / force / cancel); no global notification surface.
function OldVersionAgents({ row, store }: { row: HarnessProbeRow; store: Store }) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const setEntryPending = (entry: string, on: boolean) =>
    setPending((cur) => {
      const next = new Set(cur);
      if (on) next.add(entry);
      else next.delete(entry);
      return next;
    });
  const target = row.latest ?? row.version;
  return (
    <div className="harness-old-agents" role="group" aria-label={`Agents running an older ${row.id}`}>
      <div className="harness-old-agents-title">
        running an older {row.id}{target ? ` — restart to adopt v${target}` : ""}:
      </div>
      {row.runningAgentsUsingOldVersion.map((entry) => {
        const slash = entry.indexOf("/");
        const mesh = slash >= 0 ? entry.slice(0, slash) : entry;
        const agent = slash >= 0 ? entry.slice(slash + 1) : entry;
        const isPending = pending.has(entry);
        return (
          <div className="harness-old-agent" key={entry}>
            <span className="harness-old-agent-id">{entry}</span>
            {isPending ? (
              <>
                <span className="harness-old-agent-state">restart pending (after current turn)</span>
                <Btn small kind="ghost" ariaLabel={`Cancel pending restart for ${entry}`} onClick={() => void store.respawnAgent(mesh, agent, "cancel").then(() => setEntryPending(entry, false))}>
                  cancel
                </Btn>
              </>
            ) : (
              <>
                <Btn small kind="go" ariaLabel={`Restart ${entry} after current turn`} onClick={() => void store.respawnAgent(mesh, agent, "after-idle").then(() => setEntryPending(entry, true))}>
                  Restart agent
                </Btn>
                <ConfirmButton
                  small
                  kind="stop"
                  confirmLabel="Force restart agent will lose current ACP session context (mailbox preserved). Continue?"
                  ariaLabel={`Force restart ${entry}`}
                  onConfirm={() => void store.respawnAgent(mesh, agent, "force").then(() => setEntryPending(entry, false))}
                >
                  force
                </ConfirmButton>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SelfInstallerGuide({ row, command, docsUrl, onReprobe }: { row: HarnessProbeRow; command: string; docsUrl: string; onReprobe: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copyCommand() {
    await navigator.clipboard?.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <div className="self-installer-guide">
      <pre><code>{command}</code></pre>
      <span className="self-installer-actions">
        <Btn small kind="ghost" onClick={() => void copyCommand()} ariaLabel={`Copy install command for ${row.id}`}>{copied ? "copied" : "copy command"}</Btn>
        <a className="btn sm ghost" href={docsUrl} target="_blank" rel="noreferrer" aria-label={`Open official installation docs for ${row.id}`}>official docs</a>
        <Btn small kind="go" onClick={onReprobe} ariaLabel={`Done? Reprobe to detect ${row.id}`}>Done? Reprobe to detect</Btn>
      </span>
    </div>
  );
}

function InstallProgress({ install, onRetry, onClose }: { install: InstallState; onRetry: () => void; onClose: () => void }) {
  return (
    <div className={`install-progress ${install.status}`}>
      <div className="install-head">
        <span aria-live="polite">{install.liveText}</span>
        <span className="spacer" />
        {install.status === "interrupted" ? <Btn small kind="go" onClick={onRetry}>retry stream</Btn> : null}
        {install.status !== "running" ? <Btn small kind="ghost" onClick={onClose}>close</Btn> : null}
      </div>
      <div className="install-bar" role="progressbar" aria-label={install.liveText}>
        <span className={install.status} />
      </div>
      <pre className="install-log">{install.lines.join("\n") || install.pkgSpec}</pre>
    </div>
  );
}

function statusLabel(row: HarnessProbeRow): { text: string; kind: "ok" | "warn" | "bad" | "off" } {
  if (!row.installed) return { text: "missing — install required", kind: "bad" };
  if (row.error === "registry-unavailable" || !row.latest) return { text: "version comparison unavailable", kind: "off" };
  if (row.outdated && row.version) return { text: `update available — v${row.version} → v${row.latest}`, kind: "warn" };
  if (row.version) return { text: `installed v${row.version}`, kind: "ok" };
  return { text: "installed; version unknown", kind: "off" };
}
