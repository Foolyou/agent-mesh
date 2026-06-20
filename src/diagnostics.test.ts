import { expect, test } from "bun:test";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshHostRecord } from "./mesh-registry";
import {
  authChecks,
  backendCheck,
  baseDirCheck,
  classifyMeshScan,
  collectPsDetail,
  configChecks,
  doctorExitCode,
  harnessChecks,
  probeBaseDir,
  procChecks,
  redactDetail,
  renderDoctor,
  renderPsDetail,
  runDoctor,
  scanMeshProcesses,
  summarizeDoctor,
  worstSeverity,
  type AuthReadiness,
  type DoctorCheck,
  type HarnessProbeLike,
  type PsDetail,
  type ScannedMeshSlot,
} from "./diagnostics";

function rec(name: string, pid: number): MeshHostRecord {
  return { name, pid, socketPath: `/run/${name}.sock`, proto: 1, startedAt: "2026-06-20T00:00:00.000Z" };
}

// ── classifyMeshScan (pure: running vs leaks) ─────────────────────────────────

test("classifyMeshScan: live record => running; dead record => stale_record; lone socket => orphan_socket", () => {
  const slots: ScannedMeshSlot[] = [
    { name: "ops", record: rec("ops", 100), socketExists: true, pidLive: true },
    { name: "dead", record: rec("dead", 200), socketExists: true, pidLive: false },
    { name: "ghost", record: undefined, socketExists: true, pidLive: false },
    { name: "vanished", record: rec("vanished", 300), socketExists: false, pidLive: false }, // record, dead, no sock
  ];
  const { running, leaks } = classifyMeshScan(slots);
  expect(running).toEqual([{ name: "ops", pid: 100, socketPath: "/run/ops.sock", startedAt: "2026-06-20T00:00:00.000Z" }]);
  expect(leaks.map((l) => [l.name, l.kind, l.pid])).toEqual([
    ["dead", "stale_record", 200],
    ["ghost", "orphan_socket", undefined],
    ["vanished", "stale_record", 300],
  ]);
});

// ── scanMeshProcesses (read-only; injected deps; filters .sessions.json) ───────

test("scanMeshProcesses composes registry primitives read-only and ignores .sessions.json", async () => {
  const readdir = async () => ["ops.json", "ops.sock", "old.sock", "ops.sessions.json", "notes.txt"];
  const records: Record<string, MeshHostRecord> = { ops: rec("ops", 100) };
  const alive = new Set([100]);
  const slots = await scanMeshProcesses("/run", {
    readdir,
    readRecord: async (_d, name) => records[name],
    pidAlive: (pid) => alive.has(pid),
  });
  // "ops" (record+sock, live) and "old" (sock only) — never ops.sessions / notes.txt
  expect(slots.map((s) => s.name)).toEqual(["old", "ops"]);
  expect(slots.find((s) => s.name === "ops")).toMatchObject({ socketExists: true, pidLive: true });
  expect(slots.find((s) => s.name === "old")).toMatchObject({ record: undefined, socketExists: true, pidLive: false });
});

test("scanMeshProcesses returns [] when the run dir is missing", async () => {
  const slots = await scanMeshProcesses("/run", { readdir: async () => { throw new Error("ENOENT"); } });
  expect(slots).toEqual([]);
});

// ── collectPsDetail (agents best-effort) ──────────────────────────────────────

test("collectPsDetail attaches agents for running meshes; an agentsFor failure degrades to empty", async () => {
  const readdir = async () => ["ok.json", "boom.json"];
  const records: Record<string, MeshHostRecord> = { ok: rec("ok", 1), boom: rec("boom", 2) };
  const ps = await collectPsDetail("/run", {
    readdir,
    readRecord: async (_d, name) => records[name],
    pidAlive: () => true,
    agentsFor: async (r) => {
      if (r.name === "boom") throw new Error("socket refused");
      return [{ id: "router", harness: "codex", role: "router", activity: "idle", pid: 11, contextPercent: 12 }];
    },
  });
  expect(ps.leaks).toEqual([]);
  const ok = ps.running.find((m) => m.name === "ok")!;
  expect(ok.agents).toHaveLength(1);
  expect(ok.agents[0]).toMatchObject({ id: "router", harness: "codex", role: "router", activity: "idle" });
  expect(ps.running.find((m) => m.name === "boom")!.agents).toEqual([]); // best-effort
});

// ── harness checks (adapter vs core; optional = info) ──────────────────────────

test("harnessChecks: not-installed=info, outdated/auth=warning, healthy=ok with adapter+core versions", () => {
  const probes: HarnessProbeLike[] = [
    { id: "codex", label: "Codex", installed: true, version: "0.16.0", toolVersion: "1.2.3", auth: "ok" },
    { id: "claude", label: "Claude", installed: false, auth: "unknown" },
    { id: "opencode", label: "opencode", installed: true, version: "1.0.0", outdated: true, auth: "ok" },
    { id: "kimi", label: "Kimi", installed: true, version: "0.9.0", auth: "required" },
  ];
  const m = Object.fromEntries(harnessChecks(probes).map((c) => [c.id, c]));
  expect(m["harness.codex"]).toMatchObject({ severity: "ok", ok: true });
  expect(m["harness.codex"].detail).toContain("adapter 0.16.0");
  expect(m["harness.codex"].detail).toContain("core 1.2.3");
  expect(m["harness.claude"]).toMatchObject({ severity: "info", ok: true });
  expect(m["harness.opencode"]).toMatchObject({ severity: "warning", ok: false });
  expect(m["harness.opencode"].fixHint).toBeTruthy();
  expect(m["harness.kimi"]).toMatchObject({ severity: "warning", ok: false });
});

// ── config checks ──────────────────────────────────────────────────────────────

test("configChecks: invalid mesh => error; feishu enabled-but-invalid => warning", () => {
  const checks = configChecks({
    meshes: [{ name: "good", ok: true }, { name: "bad", ok: false, error: "duplicate agent id" }],
    feishu: { configured: true, enabled: true, bindings: 0, reason: "missing required fields (appId, appSecret)" },
  });
  const m = Object.fromEntries(checks.map((c) => [c.id, c]));
  expect(m["config.meshes"]).toMatchObject({ severity: "error", ok: false });
  expect(m["config.meshes"].detail).toContain("bad (duplicate agent id)");
  expect(m["config.feishu"]).toMatchObject({ severity: "warning", ok: false });
});

test("configChecks: no meshes => info; healthy feishu => ok", () => {
  const checks = configChecks({ meshes: [], feishu: { configured: true, enabled: true, bindings: 2 } });
  const m = Object.fromEntries(checks.map((c) => [c.id, c]));
  expect(m["config.meshes"]).toMatchObject({ severity: "info", ok: true });
  expect(m["config.feishu"]).toMatchObject({ severity: "ok", ok: true });
});

// ── backend / auth / base / process ──────────────────────────────────────────

test("backendCheck: healthy=ok, record-but-unhealthy=warning, absent=info", () => {
  expect(backendCheck({ recordPresent: true, pid: 9, port: 10010, healthy: true })).toMatchObject({ severity: "ok", ok: true });
  expect(backendCheck({ recordPresent: true, pid: 9, port: 10010, healthy: false })).toMatchObject({ severity: "warning", ok: false });
  expect(backendCheck({ recordPresent: false, port: 10010, healthy: false })).toMatchObject({ severity: "info", ok: true });
});

test("authChecks: present=ok with counts, absent=info; never emits secrets", () => {
  const a: AuthReadiness = {
    devices: { present: true, approved: 2, pending: 1 },
    feishu: { present: false, approved: 0, pending: 0 },
    keys: { present: true },
  };
  const m = Object.fromEntries(authChecks(a).map((c) => [c.id, c]));
  expect(m["auth.devices"]).toMatchObject({ severity: "ok", ok: true });
  expect(m["auth.devices"].detail).toBe("device auth store: 2 approved, 1 pending");
  expect(m["auth.feishu"]).toMatchObject({ severity: "info", ok: true });
  expect(m["auth.keys"]).toMatchObject({ severity: "ok", ok: true });
  expect(m["auth.keys"].detail).toBe("auth-code key store present"); // presence only — no key id
  // no token/hash/secret anywhere
  expect(authChecks(a).map((c) => c.detail).join(" ")).not.toMatch(/sha256:|secret|token/i);
});

test("baseDirCheck: missing=info, not-writable=error, ok=ok", () => {
  expect(baseDirCheck({ path: "/x", exists: false, writable: false })).toMatchObject({ severity: "info" });
  expect(baseDirCheck({ path: "/x", exists: true, writable: false })).toMatchObject({ severity: "error", ok: false });
  expect(baseDirCheck({ path: "/x", exists: true, writable: true })).toMatchObject({ severity: "ok", ok: true });
});

test("procChecks: no leaks=ok, leaks=warning with counts + fix hint", () => {
  expect(procChecks([])).toEqual([expect.objectContaining({ severity: "ok", id: "process.leaks" })]);
  const w = procChecks([
    { name: "a", kind: "stale_record", pid: 1, detail: "x" },
    { name: "b", kind: "orphan_socket", detail: "y" },
  ])[0];
  expect(w).toMatchObject({ severity: "warning", ok: false });
  expect(w.detail).toContain("1 stale record(s), 1 orphan socket(s)");
  expect(w.fixHint).toContain("--cold");
});

// ── severity aggregation + exit code ──────────────────────────────────────────

test("worstSeverity + summarizeDoctor + doctorExitCode", () => {
  expect(worstSeverity(["ok", "info", "warning"])).toBe("warning");
  expect(worstSeverity(["ok", "info"])).toBe("info"); // info ranks above ok
  expect(worstSeverity(["ok", "ok"])).toBe("ok");
  const checks: DoctorCheck[] = [
    { id: "a", severity: "ok", ok: true, detail: "" },
    { id: "b", severity: "warning", ok: false, detail: "" },
    { id: "c", severity: "error", ok: false, detail: "" },
  ];
  const r = summarizeDoctor(checks);
  expect(r.summary).toEqual({ total: 3, ok: 1, warnings: 1, errors: 1, worst: "error" });
  expect(doctorExitCode(r)).toBe(1);
  expect(doctorExitCode(summarizeDoctor([{ id: "a", severity: "warning", ok: false, detail: "" }]))).toBe(0); // warnings don't fail
});

// ── redaction ──────────────────────────────────────────────────────────────────

test("redactDetail masks secrets and long token-like runs; checks are redacted at build time", () => {
  expect(redactDetail("appSecret=abcdef123 token: zzz")).toContain("appSecret=<redacted>");
  expect(redactDetail("appSecret=abcdef123 token: zzz")).toContain("token=<redacted>");
  expect(redactDetail("hash sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toContain("<redacted>");
  expect(redactDetail("nothing secret here")).toBe("nothing secret here");
  // a builder fed a secret-ish string still redacts it
  const c = backendCheck({ recordPresent: true, pid: 1, port: 10010, healthy: true });
  expect(c.detail).not.toMatch(/[A-Za-z0-9_-]{40,}/);
});

// ── runDoctor (fail-soft assembly) ────────────────────────────────────────────

test("runDoctor assembles all domains and turns a throwing gatherer into an error check (others still run)", async () => {
  const report = await runDoctor({
    harnessProbes: async () => [{ id: "codex", label: "Codex", installed: true, version: "1", auth: "ok" }],
    configInputs: async () => ({ meshes: [{ name: "m", ok: true }] }),
    backendStatus: async () => ({ recordPresent: false, port: 10010, healthy: false }),
    authReadiness: async () => ({ devices: { present: false, approved: 0, pending: 0 }, feishu: { present: false, approved: 0, pending: 0 }, keys: { present: false } }),
    baseDir: async () => ({ path: "/x", exists: true, writable: true }),
    procLeaks: async () => { throw new Error("scan blew up"); },
  });
  const ids = report.checks.map((c) => c.id);
  expect(ids).toContain("harness.codex");
  expect(ids).toContain("config.meshes");
  expect(ids).toContain("service.backend");
  expect(ids).toContain("base.dir");
  const procErr = report.checks.find((c) => c.id === "process.leaks")!;
  expect(procErr).toMatchObject({ severity: "error", ok: false });
  expect(procErr.detail).toContain("scan blew up");
  expect(report.summary.errors).toBe(1);
});

// ── probeBaseDir (real fs) ─────────────────────────────────────────────────────

test("probeBaseDir: existing+writable, missing, and a non-writable dir via real access(W_OK)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diag-base-"));
  try {
    expect(await probeBaseDir(dir)).toEqual({ path: dir, exists: true, writable: true });
    expect(await probeBaseDir(join(dir, "nope"))).toEqual({ path: join(dir, "nope"), exists: false, writable: false });
    const ro = join(dir, "ro");
    await mkdtemp(join(dir, "x-")); // ensure dir exists for context
    await Bun.write(join(dir, "marker"), "x");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(ro);
    await chmod(ro, 0o555); // r-x: owner has no write → access(W_OK) must fail (mode-bit heuristic would miss)
    const res = await probeBaseDir(ro);
    expect(res.exists).toBe(true);
    expect(res.writable).toBe(false);
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

// ── pure renderers (CLI only renders the shared structures) ────────────────────

test("renderPsDetail: meshes + agents + leaks, and the standalone-CLI no-agent-detail note", () => {
  const ps: PsDetail = {
    running: [
      { name: "ops", pid: 7, socketPath: "/run/ops.sock", agents: [{ id: "router", harness: "codex", role: "router", activity: "unknown" }] },
      { name: "bare", pid: 8, socketPath: "/run/bare.sock", agents: [] },
    ],
    leaks: [{ name: "dead", kind: "stale_record", pid: 9, detail: 'mesh "dead" registry record points at dead pid 9' }],
  };
  const text = renderPsDetail(ps).join("\n");
  expect(text).toContain("ops\tpid 7");
  expect(text).toContain("- router\tcodex\trouter\tunknown");
  expect(text).toContain("agent detail unavailable from a standalone CLI"); // bare mesh hint
  expect(text).toContain("stale_record");
  expect(text).toContain("mesh down --cold");
});

test("renderPsDetail: empty => 'no running meshes'", () => {
  expect(renderPsDetail({ running: [], leaks: [] })).toEqual(["no running meshes"]);
});

test("renderDoctor: status marks per check + a summary line", () => {
  const report = summarizeDoctor([
    { id: "service.backend", severity: "ok", ok: true, detail: "backend healthy" },
    { id: "harness.kimi", severity: "warning", ok: false, detail: "auth required", fixHint: "log in" },
    { id: "config.meshes", severity: "error", ok: false, detail: "1 invalid", fixHint: "fix it" },
  ]);
  const lines = renderDoctor(report);
  expect(lines[0]).toContain("✓ [service.backend] backend healthy");
  expect(lines[1]).toContain("! [harness.kimi] auth required");
  expect(lines[1]).toContain("→ log in");
  expect(lines[2]).toContain("✗ [config.meshes] 1 invalid");
  expect(lines.at(-1)).toContain("1/3 ok · 1 warning(s) · 1 error(s)");
});
