// Step 7.4-A — focused SSR tests for the /bnw Doctor surface (mockup 08). The stateful
// BnwDoctor fetches via effects (covered by bnw.e2e against a fake gateway); here we render
// the presentational pieces against fixtures + assert the loading skeleton of the shell.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BnwDoctor, DoctorSummary, DoctorFindings, DaemonTable, DoctorRecovery } from "./doctor";
import type { DoctorReport, GatewayState, PsDetail } from "../../types";
import type { Store } from "../store";

const REPORT: DoctorReport = {
  checks: [
    { id: "host.key", severity: "ok", ok: true, detail: "host key present" },
    { id: "harness.codex", severity: "warning", ok: false, detail: "codex-acp outdated", fixHint: "update from Harnesses" },
    { id: "harness.opencode", severity: "error", ok: false, detail: "opencode not installed" },
  ],
  summary: { total: 3, ok: 1, warnings: 1, errors: 1, worst: "error" },
};
const PS: PsDetail = {
  running: [{ name: "dev-mesh", pid: 4830, socketPath: "~/.agent-mesh/run/dev-mesh.sock", startedAt: new Date(Date.now() - 3600_000).toISOString(), agents: [{ id: "router", activity: "idle" }, { id: "codex-1", activity: "working" }] }],
  leaks: [
    { name: "scratch", kind: "stale_record", pid: 3001, detail: "record points at dead pid 3001" },
    { name: "old-mesh", kind: "orphan_socket", detail: "orphan socket with no live owner" },
  ],
};
const noop = () => {};

test("BnwDoctor shell: PanelFrame + refresh; SSR (no effects) shows loading skeleton", () => {
  const STUB = { fetchDoctor: async () => REPORT, fetchPsDetail: async () => PS } as unknown as Store;
  const state: GatewayState = { appVersion: "build-x", meshes: [], assistant: { status: "absent", transcript: [] }, perMesh: {} };
  const out = renderToStaticMarkup(<BnwDoctor store={STUB} state={state} />);
  expect(out).toContain('data-doctor="panel"');
  expect(out).toContain("Doctor / 系统");
  expect(out).toContain('aria-label="refresh diagnostics"');
  expect(out).toContain("animate-pulse"); // loading skeleton present pre-effect (effects don't run in SSR)
  expect(out).not.toContain("data-doctor-summary"); // not loaded yet
});

test("DoctorSummary: worst chip + counts + version line + copy/run actions", () => {
  const out = renderToStaticMarkup(<DoctorSummary report={REPORT} appVersion="build-x" offline={false} running={false} onRun={noop} onCopy={noop} />);
  expect(out).toContain("data-doctor-summary");
  expect(out).toContain("worst: error");
  expect(out).toContain("1 ok · 1 warn · 1 error · 3 总计");
  expect(out).toContain("agent-mesh build-x");
  expect(out).toContain('aria-label="copy diagnostics"');
  expect(out).toContain('aria-label="run doctor"');
});

test("DoctorSummary offline: cached version tag + actions disabled", () => {
  const out = renderToStaticMarkup(<DoctorSummary report={REPORT} appVersion="build-x" offline={true} running={false} onRun={noop} onCopy={noop} />);
  expect(out).toContain("（cached）");
  expect(out).toMatch(/aria-label="run doctor"[^>]*disabled/);
});

test("DoctorFindings: each check renders id + severity chip + detail + fixHint", () => {
  const out = renderToStaticMarkup(<DoctorFindings report={REPORT} />);
  expect(out).toContain("doctor findings (3)");
  expect(out).toContain("host.key");
  expect(out).toContain("codex-acp outdated");
  expect(out).toContain("↳ update from Harnesses"); // fixHint
  expect(out).toContain("opencode not installed");
});

test("DaemonTable: real ps rows (pid/uptime/agents) + restart control", () => {
  const out = renderToStaticMarkup(<DaemonTable ps={PS} disabled={false} onRestart={noop} />);
  expect(out).toContain("data-daemons");
  expect(out).toContain("mesh-host daemons · ps (1)");
  expect(out).toContain("dev-mesh");
  expect(out).toContain("pid 4830");
  expect(out).toContain("2 agents");
  expect(out).toContain('aria-label="restart daemon dev-mesh"');
});

test("DaemonTable empty: none running", () => {
  expect(renderToStaticMarkup(<DaemonTable ps={{ running: [], leaks: [] }} disabled={false} onRestart={noop} />)).toContain("none running.");
});

test("DoctorRecovery: leak rows + per-leak reap + reap-all; restart/reap disabled when offline", () => {
  const out = renderToStaticMarkup(<DoctorRecovery ps={PS} disabled={false} busy={false} onReap={noop} />);
  expect(out).toContain("data-recovery");
  expect(out).toContain("孤儿/僵尸进程 (2)");
  expect(out).toContain('aria-label="reap all orphans"');
  expect(out).toContain('aria-label="reap scratch"');
  expect(out).toContain('aria-label="reap old-mesh"');
  expect(out).toContain("stale_record");
  expect(out).toContain("orphan_socket");
  const off = renderToStaticMarkup(<DoctorRecovery ps={PS} disabled={true} busy={false} onReap={noop} />);
  expect(off).toMatch(/aria-label="reap scratch"[^>]*disabled/);
});

test("DoctorRecovery empty: no leaks message + reap-all disabled", () => {
  const out = renderToStaticMarkup(<DoctorRecovery ps={{ running: [], leaks: [] }} disabled={false} busy={false} onReap={noop} />);
  expect(out).toContain("无孤儿/僵尸进程。");
  expect(out).toMatch(/aria-label="reap all orphans"[^>]*disabled/);
});
