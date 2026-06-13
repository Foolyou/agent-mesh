// src/mesh-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshManager } from "./mesh-manager";
import { readSessionState, writeSessionState } from "./session-storage";
import type { MeshConfig, MeshEvent } from "./acp/types";

const cfg: MeshConfig = {
  name: "echo",
  agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }],
  edges: [],
};
const edgeCfg: MeshConfig = {
  name: "edges",
  agents: [
    { id: "r", harness: "claude", project: "test_mesh_0", role: "router" },
    { id: "a", harness: "codex", project: "test_mesh_0", role: "member" },
    { id: "b", harness: "codex", project: "test_mesh_0", role: "member" },
  ],
  edges: [{ from: "r", to: "a" }],
};
const FIXTURE = join(import.meta.dir, "fixtures", "echo-host.ts");

let dir: string;
let mgr: MeshManager;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mgr-"));
  mgr = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
});
afterEach(async () => { await mgr.stopAll(); await rm(dir, { recursive: true, force: true }); });

async function waitForPidExit(pid: number, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

test("defineMesh persists and listMeshes shows it stopped", async () => {
  await mgr.defineMesh(cfg);
  expect(mgr.listMeshes()).toEqual([{ name: "echo", defined: true, status: "stopped" }]);
});

test("setAgentEffort persists the effort and reloads from disk (no restart)", async () => {
  await mgr.defineMesh(cfg);
  await mgr.setAgentEffort("echo", "r", "high");
  expect(mgr.configOf("echo").agents[0].effort).toBe("high");
  expect(mgr.listMeshes()[0].status).toBe("stopped"); // unchanged — no restart
  // persisted: a fresh manager loading the same dir sees the effort
  const fresh = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
  await fresh.loadDefinitions();
  expect(fresh.configOf("echo").agents[0].effort).toBe("high");
  await mgr.setAgentEffort("echo", "r", undefined); // clearing back to default works
  expect(mgr.configOf("echo").agents[0].effort).toBeUndefined();
});

test("setAgentEffort forwards runtime-only advertised values without persisting them", async () => {
  await mgr.defineMesh(cfg);
  const calls: any[] = [];
  (mgr as any).entries.get("echo").client = { setEffort: (agent: string, effort?: string) => calls.push({ agent, effort }) };

  await mgr.setAgentEffort("echo", "r", "max");

  expect(calls).toEqual([{ agent: "r", effort: "max" }]);
  expect(mgr.configOf("echo").agents[0].effort).toBeUndefined();
});


test("setAgentEffort on an unknown agent throws", async () => {
  await mgr.defineMesh(cfg);
  await expect(mgr.setAgentEffort("echo", "nope", "low")).rejects.toThrow(/no agent/i);
});

test("newAllSessions on a stopped mesh blanks persisted session ids on disk", async () => {
  await mgr.defineMesh(cfg);
  const runDir = join(dir, "run");
  await writeSessionState(runDir, "echo", {
    meshExpectedAlive: true,
    agents: { r: { sessionId: "sid", cwd: ".", harness: "claude" } },
  });
  await mgr.newAllSessions("echo"); // mesh is stopped → writes disk directly
  expect((await readSessionState(runDir, "echo")).agents.r.sessionId).toBe("");
});

test("newAgentSession on a stopped mesh blanks one agent's id on disk", async () => {
  await mgr.defineMesh(cfg);
  const runDir = join(dir, "run");
  await writeSessionState(runDir, "echo", {
    meshExpectedAlive: true,
    agents: { r: { sessionId: "sid", cwd: ".", harness: "claude" } },
  });
  await mgr.newAgentSession("echo", "r");
  expect((await readSessionState(runDir, "echo")).agents.r.sessionId).toBe("");
});

test("startMesh with fresh session strategy blanks persisted session ids before daemon start", async () => {
  await mgr.defineMesh(cfg);
  const runDir = join(dir, "run");
  await writeSessionState(runDir, "echo", {
    meshExpectedAlive: false,
    agents: { r: { sessionId: "sid", cwd: ".", harness: "claude", mode: "build", mailCursor: "mail-r" } },
  });

  await mgr.startMesh("echo", { sessionStrategy: "fresh" });

  const rec = (await readSessionState(runDir, "echo")).agents.r;
  expect(rec.sessionId).toBe("");
  expect(rec.mode).toBe("build");
  expect(rec.mailCursor).toBe("mail-r");
});

test("newAgentSession on an unknown agent throws", async () => {
  await mgr.defineMesh(cfg);
  await expect(mgr.newAgentSession("echo", "nope")).rejects.toThrow(/no agent/i);
});

test("setMode and setModel persist runtime selections and reload from disk", async () => {
  await mgr.defineMesh(cfg);
  await mgr.setMode("echo", "r", "plan");
  await mgr.setModel("echo", "r", "deepseek/deepseek-chat");
  expect(mgr.configOf("echo").agents[0].mode).toBe("plan");
  expect(mgr.configOf("echo").agents[0].model).toBe("deepseek/deepseek-chat");
  expect(mgr.listMeshes()[0].status).toBe("stopped");

  const fresh = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
  await fresh.loadDefinitions();
  expect(fresh.configOf("echo").agents[0].mode).toBe("plan");
  expect(fresh.configOf("echo").agents[0].model).toBe("deepseek/deepseek-chat");
});

test("setMode and setModel are allowed while running", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await mgr.setMode("echo", "r", "plan");
  await mgr.setModel("echo", "r", "test-model");
  expect(mgr.listMeshes()[0].status).toBe("running");
  expect(mgr.configOf("echo").agents[0].mode).toBe("plan");
  expect(mgr.configOf("echo").agents[0].model).toBe("test-model");
});

test("addEdge updates parent config, persists, then sends daemon RPC", async () => {
  await mgr.defineMesh(edgeCfg);
  const rpc: any[] = [];
  const entry = (mgr as any).entries.get("edges");
  entry.status = "running";
  entry.client = { addEdge: (edge: any) => rpc.push(edge) };

  await mgr.addEdge("edges", { from: "a", to: "b" });

  expect(mgr.configOf("edges").edges).toContainEqual({ from: "a", to: "b", steer: false });
  expect(rpc).toEqual([{ from: "a", to: "b", steer: false }]);
  const fresh = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
  await fresh.loadDefinitions();
  expect(fresh.configOf("edges").edges).toContainEqual({ from: "a", to: "b", steer: false });
});

test("addEdge rolls back parent memory and skips daemon RPC when persistence fails", async () => {
  await mgr.defineMesh(edgeCfg);
  const rpc: any[] = [];
  const entry = (mgr as any).entries.get("edges");
  entry.status = "running";
  entry.client = { addEdge: (edge: any) => rpc.push(edge) };
  const store = (mgr as any).store;
  const originalDefine = store.define.bind(store);
  store.define = async () => {
    throw new Error("disk full");
  };

  await expect(mgr.addEdge("edges", { from: "a", to: "b" })).rejects.toThrow(/disk full/);

  expect(mgr.configOf("edges").edges).toEqual(edgeCfg.edges);
  expect(rpc).toEqual([]);
  store.define = originalDefine;
});

test("addEdge keeps persisted parent config when daemon RPC fails", async () => {
  await mgr.defineMesh(edgeCfg);
  const entry = (mgr as any).entries.get("edges");
  entry.status = "running";
  entry.client = {
    addEdge() {
      throw new Error("socket closed");
    },
  };
  const events: MeshEvent[] = [];
  mgr.on((_name, e) => events.push(e));

  await mgr.addEdge("edges", { from: "a", to: "b" });

  expect(mgr.configOf("edges").edges).toContainEqual({ from: "a", to: "b", steer: false });
  const fresh = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
  await fresh.loadDefinitions();
  expect(fresh.configOf("edges").edges).toContainEqual({ from: "a", to: "b", steer: false });
  expect(events).toContainEqual(expect.objectContaining({ kind: "log", text: expect.stringContaining("addEdge RPC failed") }));
});

test("addEdge validates duplicates, steer-to-router, and dead targets", async () => {
  await mgr.defineMesh(edgeCfg);
  const entry = (mgr as any).entries.get("edges");
  entry.status = "running";
  entry.client = { addEdge() {} };

  await expect(mgr.addEdge("edges", { from: "r", to: "a" })).rejects.toThrow(/already exists/i);
  await expect(mgr.addEdge("edges", { from: "a", to: "r", steer: true })).rejects.toThrow(/steer.*router/i);
  (mgr as any).agentStatuses ??= new Map();
  (mgr as any).agentStatuses.set("edges", new Map([["b", "dead"]]));
  await expect(mgr.addEdge("edges", { from: "a", to: "b" })).rejects.toThrow(/dead/i);
});

test("addAgent updates parent config, persists, then sends daemon RPC", async () => {
  await mgr.defineMesh(edgeCfg);
  const rpc: any[] = [];
  const entry = (mgr as any).entries.get("edges");
  entry.status = "running";
  entry.client = { addAgent: (agent: any, edges?: any[]) => rpc.push({ agent, edges }) };

  await mgr.addAgent("edges", { id: "c", harness: "codex", project: "test_mesh_0", role: "member" });

  expect(mgr.configOf("edges").agents).toContainEqual({ id: "c", harness: "codex", project: "test_mesh_0", role: "member", lazy: true });
  expect(rpc).toEqual([{ agent: { id: "c", harness: "codex", project: "test_mesh_0", role: "member", lazy: true }, edges: [] }]);
  const fresh = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
  await fresh.loadDefinitions();
  expect(fresh.configOf("edges").agents).toContainEqual({ id: "c", harness: "codex", project: "test_mesh_0", role: "member", lazy: true });
});

test("addAgent can persist optional edges in the same update", async () => {
  await mgr.defineMesh(edgeCfg);
  const rpc: any[] = [];
  const entry = (mgr as any).entries.get("edges");
  entry.status = "running";
  entry.client = { addAgent: (agent: any, edges?: any[]) => rpc.push({ agent, edges }) };

  await mgr.addAgent("edges", { id: "c", harness: "codex", project: "test_mesh_0", role: "member" }, [{ from: "a", to: "c" }]);

  expect(mgr.configOf("edges").edges).toContainEqual({ from: "a", to: "c", steer: false });
  expect(rpc[0].edges).toEqual([{ from: "a", to: "c", steer: false }]);
});

test("addAgent rolls back parent memory and skips daemon RPC when persistence fails", async () => {
  await mgr.defineMesh(edgeCfg);
  const rpc: any[] = [];
  const entry = (mgr as any).entries.get("edges");
  entry.status = "running";
  entry.client = { addAgent: (agent: any) => rpc.push(agent) };
  const store = (mgr as any).store;
  const originalDefine = store.define.bind(store);
  store.define = async () => {
    throw new Error("disk full");
  };

  await expect(mgr.addAgent("edges", { id: "c", harness: "codex", project: "test_mesh_0", role: "member" })).rejects.toThrow(/disk full/);

  expect(mgr.configOf("edges").agents.map((a) => a.id)).toEqual(edgeCfg.agents.map((a) => a.id));
  expect(rpc).toEqual([]);
  store.define = originalDefine;
});

test("addAgent keeps persisted parent config when daemon RPC fails", async () => {
  await mgr.defineMesh(edgeCfg);
  const entry = (mgr as any).entries.get("edges");
  entry.status = "running";
  entry.client = {
    addAgent() {
      throw new Error("socket closed");
    },
  };
  const events: MeshEvent[] = [];
  mgr.on((_name, e) => events.push(e));

  await mgr.addAgent("edges", { id: "c", harness: "codex", project: "test_mesh_0", role: "member" });

  expect(mgr.configOf("edges").agents).toContainEqual({ id: "c", harness: "codex", project: "test_mesh_0", role: "member", lazy: true });
  const fresh = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
  await fresh.loadDefinitions();
  expect(fresh.configOf("edges").agents).toContainEqual({ id: "c", harness: "codex", project: "test_mesh_0", role: "member", lazy: true });
  expect(events).toContainEqual(expect.objectContaining({ kind: "log", text: expect.stringContaining("addAgent RPC failed") }));
});

test("addAgent rejects duplicate ids, duplicate routers, and invalid harnesses", async () => {
  await mgr.defineMesh(edgeCfg);
  await expect(mgr.addAgent("edges", { id: "a", harness: "codex", project: "test_mesh_0", role: "member" })).rejects.toThrow(/duplicate agent id/i);
  await expect(mgr.addAgent("edges", { id: "r2", harness: "claude", project: "test_mesh_0", role: "router" })).rejects.toThrow(/router/i);
  await expect(mgr.addAgent("edges", { id: "x", harness: "missing" as any, project: "test_mesh_0", role: "member" })).rejects.toThrow(/unknown harness/i);
});

test("setMode and setModel on an unknown agent throw", async () => {
  await mgr.defineMesh(cfg);
  await expect(mgr.setMode("echo", "nope", "plan")).rejects.toThrow(/no agent/i);
  await expect(mgr.setModel("echo", "nope", "test-model")).rejects.toThrow(/no agent/i);
});

test("root option derives meshesDir (<root>/meshes)", async () => {
  const { existsSync } = await import("node:fs");
  const r = await mkdtemp(join(tmpdir(), "root-"));
  const m = new MeshManager({ root: r, hostScript: FIXTURE });
  await m.defineMesh(cfg);
  expect(existsSync(join(r, "meshes", "echo.json"))).toBe(true);
  await m.stopAll();
  await rm(r, { recursive: true, force: true });
});

test("defineMesh rejects an invalid topology", async () => {
  await expect(mgr.defineMesh({ ...cfg, agents: [] })).rejects.toThrow(/at least one/i);
});

test("deleteMesh forgets a stopped mesh", async () => {
  await mgr.defineMesh(cfg);
  await mgr.deleteMesh("echo");
  expect(mgr.listMeshes()).toEqual([]);
});

test("deleteMesh removes mesh upload bucket but keeps assistant uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "mgr-root-"));
  const m = new MeshManager({ root, hostScript: FIXTURE });
  const { existsSync } = await import("node:fs");
  try {
    await m.defineMesh(cfg);
    await mkdir(join(root, "uploads", "echo"), { recursive: true });
    await mkdir(join(root, "uploads", "assistant"), { recursive: true });
    await writeFile(join(root, "uploads", "echo", "x.png"), "x");
    await writeFile(join(root, "uploads", "assistant", "x.png"), "x");
    await m.deleteMesh("echo");
    expect(existsSync(join(root, "uploads", "echo"))).toBe(false);
    expect(existsSync(join(root, "uploads", "assistant", "x.png"))).toBe(true);
  } finally {
    await m.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("deleteMesh removes mesh artifact bucket", async () => {
  const root = await mkdtemp(join(tmpdir(), "mgr-artifacts-root-"));
  const m = new MeshManager({ root, hostScript: FIXTURE });
  const { existsSync } = await import("node:fs");
  try {
    await m.defineMesh(cfg);
    await mkdir(join(root, "artifacts", "echo", "r"), { recursive: true });
    await writeFile(join(root, "artifacts", "echo", "r", "diagram.png"), "x");
    await m.deleteMesh("echo");
    expect(existsSync(join(root, "artifacts", "echo"))).toBe(false);
  } finally {
    await m.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("loadDefinitions rejects manually edited unsafe artifact names", async () => {
  await mkdir(join(dir, "meshes"), { recursive: true });
  await writeFile(
    join(dir, "meshes", "unsafe.json"),
    JSON.stringify({ ...cfg, name: "bad..mesh", agents: [{ ...cfg.agents[0]!, id: "bad/agent" }] }),
  );
  await expect(mgr.loadDefinitions()).rejects.toThrow(/invalid/i);
});

test("deleteMesh refuses while running", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await expect(mgr.deleteMesh("echo")).rejects.toThrow(/running/i);
  expect(mgr.listMeshes()[0]!.status).toBe("running");
});

test("defineMesh still refuses full replacement while running", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await expect(mgr.defineMesh({ ...cfg, charter: "replace" })).rejects.toThrow(/running/i);
  expect(mgr.configOf("echo").charter).toBeUndefined();
});

test("start -> running -> promptRouter relays events -> stop -> stopped, no orphan", async () => {
  await mgr.defineMesh(cfg);
  const events: { name: string; e: MeshEvent }[] = [];
  mgr.on((name, e) => events.push({ name, e }));

  await mgr.startMesh("echo");
  expect(mgr.listMeshes()[0]!.status).toBe("running");
  const pid = mgr.pidOf("echo")!;

  await mgr.promptRouter("echo", "ping");
  await Bun.sleep(100);
  expect(events.some((x) => x.name === "echo" && x.e.kind === "log" && (x.e as any).text === "echo:ping")).toBe(true);

  await mgr.stopMesh("echo");
  expect(mgr.listMeshes()[0]!.status).toBe("stopped");
  await waitForPidExit(pid);
});

test("explicit start flips meshExpectedAlive back to true", async () => {
  await mgr.defineMesh(cfg);
  const runDir = join(dir, "run");
  await writeSessionState(runDir, "echo", {
    meshExpectedAlive: false,
    agents: { r: { sessionId: "sid", cwd: "test_mesh_0", harness: "claude" } },
  });

  await mgr.startMesh("echo");

  expect((await readSessionState(runDir, "echo")).meshExpectedAlive).toBe(true);
});

test("startMesh twice errors", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await expect(mgr.startMesh("echo")).rejects.toThrow(/already running/i);
});

test("a daemon outlives the backend: reattachRunning reconnects + replays + drives it", async () => {
  await mgr.defineMesh(cfg);
  const ev1: MeshEvent[] = [];
  mgr.on((_n, e) => ev1.push(e));
  await mgr.startMesh("echo");
  await mgr.promptRouter("echo", "before"); // an event lands in the daemon's replay ring
  await Bun.sleep(100);
  expect(ev1.some((e) => e.kind === "log" && (e as any).text === "echo:before")).toBe(true);
  const pid = mgr.pidOf("echo")!;

  // simulate a backend restart: disconnect WITHOUT stopping — the daemon keeps running
  mgr.disconnectAll();
  expect(() => process.kill(pid, 0)).not.toThrow(); // daemon still alive after disconnect

  // a fresh manager on the same runDir discovers + reattaches to the live daemon
  const mgr2 = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
  await mgr2.loadDefinitions();
  const ev2: MeshEvent[] = [];
  mgr2.on((_n, e) => ev2.push(e));
  const back = await mgr2.reattachRunning();
  expect(back).toEqual(["echo"]);
  expect(mgr2.listMeshes()[0]!.status).toBe("running");
  expect(mgr2.pidOf("echo")).toBe(pid); // same daemon process, not a new one

  // replay rebuilt the pre-restart event into the fresh manager's stream
  await Bun.sleep(50);
  expect(ev2.some((e) => e.kind === "log" && (e as any).text === "echo:before")).toBe(true);
  expect(ev2).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "r", status: "ready" }));
  expect(ev2).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "r", activity: "idle" }));
  expect(ev2).toContainEqual(expect.objectContaining({ kind: "agent_capabilities", agent: "r", image: true }));
  expect(ev2).toContainEqual(expect.objectContaining({ kind: "agent_modes", agent: "r", current: "default" }));

  // and the fresh manager can drive the reattached daemon
  mgr2.promptAgent("echo", "r", "after");
  await Bun.sleep(150);
  expect(ev2.some((e) => e.kind === "log" && (e as any).text === "echo:after")).toBe(true);

  await mgr2.stopMesh("echo");
  await waitForPidExit(pid); // now truly reaped
});

test("a crashed mesh host is reaped: status dead, socket file removed, restartable", async () => {
  const CRASH = join(import.meta.dir, "fixtures", "crash-host.ts");
  const crashMgr = new MeshManager({ meshesDir: join(dir, "meshes2"), runDir: join(dir, "run2"), hostScript: CRASH });
  await crashMgr.defineMesh(cfg);
  await crashMgr.startMesh("echo");           // resolves on ready
  // wait for the self-exit to be observed
  await Bun.sleep(400);
  expect(crashMgr.listMeshes()[0]!.status).toBe("dead");
  // socket file should be gone
  const sock = join(dir, "run2", "echo.sock");
  const { existsSync } = await import("node:fs");
  expect(existsSync(sock)).toBe(false);
  await crashMgr.stopAll();
});

test("startMesh resets status to stopped when the host fails to start", async () => {
  await mgr.defineMesh(cfg);
  // point at a nonexistent host script so the child exits before ready
  const bad = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: join(dir, "nope.ts") });
  await bad.defineMesh(cfg);
  await expect(bad.startMesh("echo")).rejects.toThrow();
  expect(bad.listMeshes()[0]!.status).toBe("stopped");
  // and it can be retried (not stuck on "already running")
  await expect(bad.startMesh("echo")).rejects.toThrow();
});
