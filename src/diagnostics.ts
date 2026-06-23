// src/diagnostics.ts
//
// Shared, structured diagnostics for `mesh ps -v` (CLI) AND the web system-health/process panel.
// ONE source of truth: this module produces plain data (`PsDetail`, `DoctorReport`); the CLI and the
// web client only RENDER it — neither re-derives the logic. (Commit 1 of mesh-ps-doctor: the data
// model + builders + tests; the CLI/web wiring lands in later commits.)
//
// Design split:
//   - PURE builders (classifyMeshScan, the per-domain doctor checks, summarizeDoctor, redaction) — the
//     testable heart, no IO.
//   - THIN injectable gatherers (scanMeshProcesses, runDoctor) — compose the EXISTING modules
//     (mesh-registry pidAlive/readRecord, harness-probe, mesh-validate, auth-store paths, a backend
//     liveness probe) and never re-implement their judgment. Every external call is an injectable dep
//     so tests run without spawning processes or touching real files.
//
// Secret hygiene: outputs are structured for an operator and MUST NOT carry credentials — no
// appSecret, bearer/device token, AES key, or raw secret ever appears in any `detail`. Auth checks
// report presence/counts only; config checks report validation messages, never secret field values.

import { access, readdir, stat } from "node:fs/promises";
import { constants as FS } from "node:fs";
import type { AgentRole, HarnessId } from "./acp/types";
import { pidAlive, readRecord, type MeshHostRecord } from "./mesh-registry";

// ── structured model ──────────────────────────────────────────────────────────

/** Ordered worst-last. `ok`/`info` are passing; `warning`/`error` are problems. */
export const SEVERITY_ORDER = ["ok", "info", "warning", "error"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export interface DoctorCheck {
  /** Stable machine id, e.g. "harness.codex", "config.meshes", "service.backend", "auth.store". */
  id: string;
  severity: Severity;
  /** Convenience: true iff the check passed (severity ok|info). */
  ok: boolean;
  /** Operator-facing, secret-free one-liner. */
  detail: string;
  /** How to fix it, when not ok. */
  fixHint?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: { total: number; ok: number; warnings: number; errors: number; worst: Severity };
}

export type AgentActivityState = "idle" | "working" | "unknown";

export interface AgentDetail {
  id: string;
  harness?: HarnessId;
  role?: AgentRole;
  activity: AgentActivityState;
  pid?: number;
  status?: string;
  /** Context-window usage, when available (normalized percent 0–100 + raw used/size). */
  contextPercent?: number;
  contextUsed?: number;
  contextSize?: number;
}

export interface MeshProcDetail {
  name: string;
  pid: number;
  socketPath: string;
  startedAt?: string;
  agents: AgentDetail[];
}

export type ProcLeakKind = "stale_record" | "orphan_socket";

export interface ProcLeak {
  name: string;
  kind: ProcLeakKind;
  /** Dead pid for a stale record; undefined for an orphan socket. */
  pid?: number;
  detail: string;
}

export interface PsDetail {
  running: MeshProcDetail[];
  leaks: ProcLeak[];
}

// ── severity helpers (pure) ─────────────────────────────────────────────────────

export function worstSeverity(severities: readonly Severity[]): Severity {
  return severities.reduce<Severity>((worst, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst), "ok");
}

function check(id: string, severity: Severity, detail: string, fixHint?: string): DoctorCheck {
  const ok = severity === "ok" || severity === "info";
  return { id, severity, ok, detail: redactDetail(detail), ...(fixHint && !ok ? { fixHint } : {}) };
}

/** Final guard against leaking a secret into a `detail` string. Builders already avoid secret fields;
 *  this masks anything that still looks like one (long token-ish runs, `key=...`, `secret=...`). */
export function redactDetail(detail: string): string {
  return detail
    .replace(/\b(appSecret|secret|token|tokenHash|apiKey|api_key|key)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<redacted>");
}

// ── ps-detail: running meshes + orphans/leaks ────────────────────────────────────

/** One scanned mesh-host slot under the run dir. Read-only — mirrors the records-vs-sockets scan in
 *  mesh-registry.reapAllHosts but neither prunes nor kills (diagnostics never mutate). */
export interface ScannedMeshSlot {
  name: string;
  record?: MeshHostRecord;
  socketExists: boolean;
  pidLive: boolean;
}

/** Classify a read-only scan into running meshes and leaks. Pure. Mirrors the registry's own rules:
 *  live record = running; record with a dead pid = stale record (reap would clean it); a `.sock` with
 *  no live record = orphaned socket. */
export function classifyMeshScan(slots: readonly ScannedMeshSlot[]): {
  running: { name: string; pid: number; socketPath: string; startedAt?: string }[];
  leaks: ProcLeak[];
} {
  const running: { name: string; pid: number; socketPath: string; startedAt?: string }[] = [];
  const leaks: ProcLeak[] = [];
  for (const s of slots) {
    if (s.record && s.pidLive) {
      running.push({ name: s.name, pid: s.record.pid, socketPath: s.record.socketPath, startedAt: s.record.startedAt });
    } else if (s.record && !s.pidLive) {
      leaks.push({ name: s.name, kind: "stale_record", pid: s.record.pid, detail: `mesh "${s.name}" registry record points at dead pid ${s.record.pid}` });
    } else if (s.socketExists) {
      leaks.push({ name: s.name, kind: "orphan_socket", detail: `orphaned socket for mesh "${s.name}" with no live daemon record` });
    }
  }
  return { running, leaks };
}

export interface ScanMeshDeps {
  readdir?: (dir: string) => Promise<string[]>;
  readRecord?: (runDir: string, name: string) => Promise<MeshHostRecord | undefined>;
  pidAlive?: (pid: number) => boolean;
}

/** Read-only scan of the run dir into slots (records ∪ sockets), reusing mesh-registry primitives. */
export async function scanMeshProcesses(runDir: string, deps: ScanMeshDeps = {}): Promise<ScannedMeshSlot[]> {
  const _readdir = deps.readdir ?? ((d) => readdir(d));
  const _readRecord = deps.readRecord ?? readRecord;
  const _pidAlive = deps.pidAlive ?? pidAlive;
  let entries: string[];
  try {
    entries = await _readdir(runDir);
  } catch {
    return [];
  }
  // Same filename convention as mesh-registry: <name>.json (not .sessions.json) + <name>.sock.
  const recordNames = entries.filter((f) => f.endsWith(".json") && !f.endsWith(".sessions.json")).map((f) => f.slice(0, -5));
  const sockNames = entries.filter((f) => f.endsWith(".sock")).map((f) => f.slice(0, -5));
  const socketSet = new Set(sockNames);
  const names = [...new Set([...recordNames, ...sockNames])].sort();
  const slots: ScannedMeshSlot[] = [];
  for (const name of names) {
    const record = await _readRecord(runDir, name);
    slots.push({ name, record, socketExists: socketSet.has(name), pidLive: record ? _pidAlive(record.pid) : false });
  }
  return slots;
}

export interface PsDetailDeps extends ScanMeshDeps {
  /** Best-effort live agent detail for a running mesh (connect to its socket / read session state).
   *  Default: none (empty) — the model is here; the live fetch is wired by the CLI/web in a later commit. */
  agentsFor?: (record: MeshHostRecord) => Promise<AgentDetail[]>;
}

export async function collectPsDetail(runDir: string, deps: PsDetailDeps = {}): Promise<PsDetail> {
  const slots = await scanMeshProcesses(runDir, deps);
  const { running, leaks } = classifyMeshScan(slots);
  const detailed: MeshProcDetail[] = [];
  for (const r of running) {
    const rec = slots.find((s) => s.name === r.name)?.record;
    let agents: AgentDetail[] = [];
    if (rec && deps.agentsFor) {
      try {
        agents = await deps.agentsFor(rec);
      } catch {
        agents = []; // best-effort: a mesh we can't query still lists as running with no agent detail
      }
    }
    detailed.push({ name: r.name, pid: r.pid, socketPath: r.socketPath, startedAt: r.startedAt, agents });
  }
  return { running: detailed, leaks };
}

// ── doctor: per-domain checks (pure builders over already-gathered inputs) ────────

/** Harness probe result subset doctor needs (a structural slice of HarnessProbeResult). */
export interface HarnessProbeLike {
  id: HarnessId;
  label: string;
  installed: boolean;
  version?: string; // ACP adapter version
  toolVersion?: string; // underlying body tool (core) version — distinct from the adapter
  outdated?: boolean;
  auth: "ok" | "required" | "unknown";
  error?: string;
}

/** One check per probed harness. Distinguishes the ACP ADAPTER (version) from the CORE body tool
 *  (toolVersion). Not-installed harnesses are `info` (optional), not errors. */
export function harnessChecks(probes: readonly HarnessProbeLike[]): DoctorCheck[] {
  return probes.map((p) => {
    const id = `harness.${p.id}`;
    if (!p.installed) {
      return check(id, "info", `${p.label}: not installed (optional)`, `install the ${p.label} ACP adapter to use it`);
    }
    if (p.error) {
      return check(id, "warning", `${p.label}: installed but probe failed`, "check the adapter starts and speaks ACP");
    }
    const ver = `adapter ${p.version ?? "?"}${p.toolVersion ? `, core ${p.toolVersion}` : ""}`;
    if (p.outdated) {
      return check(id, "warning", `${p.label}: ${ver} (adapter outdated)`, `update the ${p.label} adapter to the pinned version`);
    }
    if (p.auth === "required") {
      return check(id, "warning", `${p.label}: ${ver}, auth required`, `log in to ${p.label} (provider credentials / subscription)`);
    }
    return check(id, "ok", `${p.label}: ${ver}`);
  });
}

/** Config validity input: one entry per mesh config + the feishu channel config summary. `error`
 *  holds a validateMeshConfig / parse message (secret-free). */
export interface ConfigInputs {
  meshes: { name: string; ok: boolean; error?: string; warnings?: string[] }[];
  feishu?: { configured: boolean; enabled: boolean; bindings: number; reason?: string };
}

export function configChecks(inputs: ConfigInputs): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const bad = inputs.meshes.filter((m) => !m.ok);
  if (!inputs.meshes.length) {
    out.push(check("config.meshes", "info", "no mesh configs found (meshes/*.json)", "create a mesh in the web console or add meshes/<name>.json"));
  } else if (bad.length) {
    out.push(check("config.meshes", "error", `${bad.length}/${inputs.meshes.length} mesh config(s) invalid: ${bad.map((m) => `${m.name} (${m.error ?? "invalid"})`).join("; ")}`, "fix the reported meshes/*.json validation errors"));
  } else {
    out.push(check("config.meshes", "ok", `${inputs.meshes.length} mesh config(s) valid`));
  }
  // Non-fatal grounding advisories for valid meshes (missing charter / per-agent instructions).
  // Separate check id so it never clobbers the config.meshes ok/error/info result above.
  const advisories = inputs.meshes.filter((m) => m.ok && m.warnings && m.warnings.length);
  if (advisories.length) {
    out.push(check("config.meshes.grounding", "warning", `${advisories.length} mesh(es) with grounding advisories: ${advisories.map((m) => `${m.name} (${m.warnings!.join("; ")})`).join("; ")}`, "optional: add a mesh charter and/or per-agent instructions; safe to ignore if intentional"));
  }
  if (inputs.feishu) {
    const f = inputs.feishu;
    if (!f.configured) {
      out.push(check("config.feishu", "info", "feishu channel not configured (optional)"));
    } else if (f.enabled && f.reason) {
      out.push(check("config.feishu", "warning", `feishu channel enabled but invalid: ${f.reason}`, "fix channels/feishu.json"));
    } else if (!f.enabled) {
      out.push(check("config.feishu", "info", `feishu channel configured, disabled${f.reason ? ` (${f.reason})` : ""}`));
    } else {
      out.push(check("config.feishu", "ok", `feishu channel enabled, ${f.bindings} binding(s)`));
    }
  }
  return out;
}

/** Backend/service status (mirrors service.ts: a record under backend.json + a <500 liveness probe). */
export interface BackendStatus {
  recordPresent: boolean;
  pid?: number;
  port: number;
  healthy: boolean;
}

export function backendCheck(s: BackendStatus): DoctorCheck {
  const id = "service.backend";
  if (s.healthy) return check(id, "ok", `backend healthy on :${s.port}${s.pid ? ` (pid ${s.pid})` : ""}`);
  if (s.recordPresent && s.pid) return check(id, "warning", `backend record present (pid ${s.pid}) but not healthy on :${s.port}`, "check the backend log; restart with scripts/update.sh");
  return check(id, "info", `backend not running on :${s.port}`, "start it with `mesh up` / scripts/update.sh");
}

/** Auth store readiness — PRESENCE + COUNTS ONLY. The gatherer may read the auth-store files to count
 *  entries, but this struct carries no tokenHash, encrypted token, key id, or any raw credential. */
export interface AuthReadiness {
  devices: { present: boolean; approved: number; pending: number };
  feishu: { present: boolean; approved: number; pending: number };
  keys: { present: boolean };
}

export function authChecks(a: AuthReadiness): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  out.push(
    a.devices.present
      ? check("auth.devices", "ok", `device auth store: ${a.devices.approved} approved, ${a.devices.pending} pending`)
      : check("auth.devices", "info", "device auth store not initialized (no devices.json)", "run `mesh device …` or open the web console to enroll a device"),
  );
  out.push(
    a.feishu.present
      ? check("auth.feishu", "ok", `feishu auth registry: ${a.feishu.approved} approved, ${a.feishu.pending} pending`)
      : check("auth.feishu", "info", "feishu auth registry not initialized (no auth/feishu.json)"),
  );
  out.push(
    a.keys.present
      ? check("auth.keys", "ok", "auth-code key store present")
      : check("auth.keys", "info", "auth-code key store not initialized (created on first authorization code)"),
  );
  return out;
}

/** `<root>/.agent-mesh` base-dir health: exists + writable. */
export interface BaseDirStatus {
  path: string;
  exists: boolean;
  writable: boolean;
}

export function baseDirCheck(s: BaseDirStatus): DoctorCheck {
  const id = "base.dir";
  if (!s.exists) return check(id, "info", `data root ${s.path} does not exist yet (created on first use)`);
  if (!s.writable) return check(id, "error", `data root ${s.path} is not writable`, "fix the directory permissions (chmod/chown) so the backend can write");
  return check(id, "ok", `data root ${s.path} writable`);
}

export function procChecks(leaks: readonly ProcLeak[]): DoctorCheck[] {
  if (!leaks.length) return [check("process.leaks", "ok", "no orphaned daemons or sockets")];
  const stale = leaks.filter((l) => l.kind === "stale_record").length;
  const orphan = leaks.filter((l) => l.kind === "orphan_socket").length;
  return [check("process.leaks", "warning", `${leaks.length} leak(s): ${stale} stale record(s), ${orphan} orphan socket(s)`, "reap them with `mesh down --cold` (cold restart)")];
}

// ── doctor: assembly + aggregation (pure) ────────────────────────────────────────

export function summarizeDoctor(checks: DoctorCheck[]): DoctorReport {
  const warnings = checks.filter((c) => c.severity === "warning").length;
  const errors = checks.filter((c) => c.severity === "error").length;
  const ok = checks.filter((c) => c.ok).length;
  return { checks, summary: { total: checks.length, ok, warnings, errors, worst: worstSeverity(checks.map((c) => c.severity)) } };
}

/** Exit code for `mesh doctor` (commit 2): non-zero on any error. Warnings are surfaced but do not
 *  fail (an optional-harness/auth warning shouldn't break automation). */
export function doctorExitCode(report: DoctorReport): number {
  return report.summary.errors > 0 ? 1 : 0;
}

// ── doctor: thin gatherer (injectable; default-wires the real modules) ────────────

export interface DoctorDeps {
  harnessProbes: () => Promise<HarnessProbeLike[]>;
  configInputs: () => Promise<ConfigInputs>;
  backendStatus: () => Promise<BackendStatus>;
  authReadiness: () => Promise<AuthReadiness>;
  baseDir: () => Promise<BaseDirStatus>;
  procLeaks: () => Promise<ProcLeak[]>;
}

/** Run every domain, fail-soft (a gatherer that throws becomes an `error` check rather than aborting
 *  the whole report), and assemble the structured DoctorReport. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const safe = async (id: string, run: () => Promise<DoctorCheck[]>): Promise<void> => {
    try {
      checks.push(...(await run()));
    } catch (e) {
      checks.push(check(id, "error", `${id} check failed: ${errMsg(e)}`, "re-run; if it persists, report the error"));
    }
  };
  await safe("harness", async () => harnessChecks(await deps.harnessProbes()));
  await safe("config", async () => configChecks(await deps.configInputs()));
  await safe("service.backend", async () => [backendCheck(await deps.backendStatus())]);
  await safe("auth", async () => authChecks(await deps.authReadiness()));
  await safe("process.leaks", async () => procChecks(await deps.procLeaks()));
  await safe("base.dir", async () => [baseDirCheck(await deps.baseDir())]);
  return summarizeDoctor(checks);
}

function errMsg(e: unknown): string {
  return redactDetail(e instanceof Error ? e.message : String(e));
}

/** Base-dir status probe (exists + writable). Writability uses a real `access(W_OK)` so it respects
 *  the effective uid, group, ACLs, and root — not just the owner mode bit. */
export async function probeBaseDir(path: string): Promise<BaseDirStatus> {
  let isDir: boolean;
  try {
    isDir = (await stat(path)).isDirectory();
  } catch {
    return { path, exists: false, writable: false };
  }
  if (!isDir) return { path, exists: true, writable: false };
  try {
    await access(path, FS.W_OK);
    return { path, exists: true, writable: true };
  } catch {
    return { path, exists: true, writable: false };
  }
}

/** Convenience for callers that pass a run dir: the standard leaks-only view. */
export async function collectProcLeaks(runDir: string, deps: ScanMeshDeps = {}): Promise<ProcLeak[]> {
  return classifyMeshScan(await scanMeshProcesses(runDir, deps)).leaks;
}

// ── pure text renderers (CLI only RENDERS the shared structures — no re-derivation) ──

const SEVERITY_MARK: Record<Severity, string> = { ok: "✓", info: "·", warning: "!", error: "✗" };

/** Render `mesh ps -v` (running meshes + agents + leaks) to plain lines. */
export function renderPsDetail(ps: PsDetail): string[] {
  const out: string[] = [];
  if (!ps.running.length) out.push("no running meshes");
  for (const m of ps.running) {
    out.push(`${m.name}\tpid ${m.pid}\t${m.socketPath}${m.startedAt ? `\tstarted ${m.startedAt}` : ""}`);
    if (!m.agents.length) {
      out.push("  (agent detail unavailable from a standalone CLI — see the web console for live status)");
    }
    for (const a of m.agents) {
      const ctx = a.contextPercent !== undefined ? `\tctx ${Math.round(a.contextPercent)}%` : "";
      const pid = a.pid !== undefined ? `\tpid ${a.pid}` : "";
      out.push(`  - ${a.id}\t${a.harness ?? "?"}\t${a.role ?? "?"}\t${a.activity}${pid}${ctx}`);
    }
  }
  if (ps.leaks.length) {
    out.push(`leaks/orphans (${ps.leaks.length}):`);
    for (const l of ps.leaks) out.push(`  ! ${l.kind}: ${l.detail}`);
    out.push("  reap with `mesh down --cold`");
  }
  return out;
}

/** Render a `mesh doctor` report to plain lines (status mark + id + detail + fix hint). */
export function renderDoctor(report: DoctorReport): string[] {
  const out = report.checks.map((c) => `${SEVERITY_MARK[c.severity]} [${c.id}] ${c.detail}${c.fixHint ? `\n    → ${c.fixHint}` : ""}`);
  const s = report.summary;
  out.push(`\n${SEVERITY_MARK[s.worst]} ${s.ok}/${s.total} ok · ${s.warnings} warning(s) · ${s.errors} error(s)`);
  return out;
}
