// Unit tests for single-mesh lifecycle orchestration (mesh-cli-lifecycle §B–§D). A fake
// MeshControlClient drives every branch: exit-code mapping, idempotent no-ops, the restart
// stop→poll→start sequence, and its timeout — no real backend.
import { test, expect } from "bun:test";
import { opStart, opStop, opStatus, opRestart, EXIT } from "./mesh-cli-ops";
import type { ControlOutcome, MeshControlClient, MeshLifecycleInfo } from "./mesh-control-client";

const mesh = (name: string, status: string, agents: MeshLifecycleInfo["agents"] = []): MeshLifecycleInfo => ({ name, status, agents });

interface FakeOpts {
  /** A single outcome, or a SEQUENCE consumed one-per-getMeshes call (for restart polling). */
  meshes?: ControlOutcome<MeshLifecycleInfo[]> | ControlOutcome<MeshLifecycleInfo[]>[];
  action?: ControlOutcome<void>;
}
function fake(opts: FakeOpts = {}) {
  const actions: { name: string; action: string; body: unknown }[] = [];
  const seq = Array.isArray(opts.meshes) ? opts.meshes : [opts.meshes ?? { ok: true, data: [] }];
  let getCalls = 0;
  const c: MeshControlClient = {
    async getMeshes() {
      return seq[Math.min(getCalls++, seq.length - 1)];
    },
    async meshAction(name, action, body) {
      actions.push({ name, action, body });
      return opts.action ?? { ok: true, data: undefined };
    },
  };
  return { c, actions };
}
const ok = (...m: MeshLifecycleInfo[]): ControlOutcome<MeshLifecycleInfo[]> => ({ ok: true, data: m });

// ── status ──

test("opStatus prints status + agents for an existing mesh (exit 0)", async () => {
  const { c } = fake({ meshes: ok(mesh("demo", "running", [{ id: "router", harness: "codex", status: "idle" }])) });
  const r = await opStatus(c, "demo");
  expect(r.exitCode).toBe(EXIT.ok);
  expect(r.out[0]).toBe("demo: running");
  expect(r.out[1]).toContain("router");
});

test("opStatus on a missing mesh → exit 4", async () => {
  const { c } = fake({ meshes: ok(mesh("other", "stopped")) });
  expect((await opStatus(c, "demo")).exitCode).toBe(EXIT.notFound);
});

test("backend-down maps to exit 5 with the `mesh up` hint", async () => {
  const { c } = fake({ meshes: { ok: false, reason: "backend-down" } });
  const r = await opStatus(c, "demo");
  expect(r.exitCode).toBe(EXIT.backendDown);
  expect(r.err.join(" ")).toContain("mesh up");
});

test("auth failure maps to exit 6", async () => {
  const { c } = fake({ meshes: { ok: false, reason: "auth" } });
  expect((await opStatus(c, "demo")).exitCode).toBe(EXIT.auth);
});

// ── start ──

test("opStart on a stopped mesh calls start and exits 0", async () => {
  const { c, actions } = fake({ meshes: ok(mesh("demo", "stopped")) });
  const r = await opStart(c, "demo", { fresh: false });
  expect(r.exitCode).toBe(EXIT.ok);
  expect(actions).toEqual([{ name: "demo", action: "start", body: undefined }]);
});

test("opStart on an already-running mesh is an idempotent no-op (exit 0, NO action)", async () => {
  const { c, actions } = fake({ meshes: ok(mesh("demo", "running")) });
  const r = await opStart(c, "demo", { fresh: false });
  expect(r.exitCode).toBe(EXIT.ok);
  expect(r.out[0]).toContain("already running");
  expect(actions).toHaveLength(0);
});

test("opStart --fresh on a running mesh still re-issues with sessionStrategy:fresh", async () => {
  const { c, actions } = fake({ meshes: ok(mesh("demo", "running")) });
  const r = await opStart(c, "demo", { fresh: true });
  expect(r.exitCode).toBe(EXIT.ok);
  expect(actions).toEqual([{ name: "demo", action: "start", body: { sessionStrategy: "fresh" } }]);
});

test("opStart on a missing mesh → exit 4 (no action)", async () => {
  const { c, actions } = fake({ meshes: ok() });
  expect((await opStart(c, "demo", { fresh: false })).exitCode).toBe(EXIT.notFound);
  expect(actions).toHaveLength(0);
});

// ── stop ──

test("opStop on a running mesh calls stop and exits 0", async () => {
  const { c, actions } = fake({ meshes: ok(mesh("demo", "running")) });
  expect((await opStop(c, "demo")).exitCode).toBe(EXIT.ok);
  expect(actions).toEqual([{ name: "demo", action: "stop", body: undefined }]);
});

test("opStop on an already-stopped mesh is an idempotent no-op", async () => {
  const { c, actions } = fake({ meshes: ok(mesh("demo", "dead")) });
  const r = await opStop(c, "demo");
  expect(r.exitCode).toBe(EXIT.ok);
  expect(r.out[0]).toContain("already stopped");
  expect(actions).toHaveLength(0);
});

// ── restart sequence ──

test("opRestart stops a running mesh, polls until stopped, then starts (exit 0)", async () => {
  // getMeshes: initial(running) → poll(running) → poll(stopped)
  const { c, actions } = fake({ meshes: [ok(mesh("demo", "running")), ok(mesh("demo", "running")), ok(mesh("demo", "stopped"))] });
  const r = await opRestart(c, "demo", { sleep: async () => {}, maxWaitMs: 10_000, pollMs: 0 });
  expect(r.exitCode).toBe(EXIT.ok);
  expect(actions.map((a) => a.action)).toEqual(["stop", "start"]); // stop, poll until stopped, then start
});

test("opRestart on an already-stopped mesh skips stop and just starts", async () => {
  const { c, actions } = fake({ meshes: ok(mesh("demo", "stopped")) });
  const r = await opRestart(c, "demo", { sleep: async () => {} });
  expect(r.exitCode).toBe(EXIT.ok);
  expect(actions.map((a) => a.action)).toEqual(["start"]);
});

test("opRestart times out (exit 1) if the mesh never reaches stopped", async () => {
  let t = 0;
  const { c } = fake({ meshes: ok(mesh("demo", "running")) }); // always running
  const r = await opRestart(c, "demo", { sleep: async () => {}, maxWaitMs: 10, pollMs: 1, now: () => (t += 1000) });
  expect(r.exitCode).toBe(EXIT.other);
  expect(r.err.join(" ")).toContain("did not stop");
});

test("opRestart on a missing mesh → exit 4", async () => {
  const { c } = fake({ meshes: ok() });
  expect((await opRestart(c, "demo", { sleep: async () => {} })).exitCode).toBe(EXIT.notFound);
});

test("a failed start action maps to exit 1 (other)", async () => {
  const { c } = fake({ meshes: ok(mesh("demo", "stopped")), action: { ok: false, reason: "error", message: "boom" } });
  const r = await opStart(c, "demo", { fresh: false });
  expect(r.exitCode).toBe(EXIT.other);
  expect(r.err.join(" ")).toContain("boom");
});
