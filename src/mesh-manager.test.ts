// src/mesh-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshManager } from "./mesh-manager";
import { MeshHostClient } from "./mesh-host-client";
import { meshSocketPath } from "./mesh-socket";
import { readRecord } from "./mesh-registry";
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
const HOST_TEST_TIMEOUT = process.platform === "win32" ? 30_000 : 10_000;
const RUNNING_FROM_WSL_UNC = process.platform === "win32" && /^\\\\wsl(?:\.localhost|\$)\\/i.test(process.cwd());
const hostTest = RUNNING_FROM_WSL_UNC ? test.skip : test;

let dir: string;
let mgr: MeshManager;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mgr-"));
  mgr = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
});
afterEach(async () => {
  const currentMgr = mgr;
  const currentDir = dir;
  await currentMgr.stopAll();
  await rm(currentDir, { recursive: true, force: true });
}, 30_000);

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
  (mgr as any).entries.get("echo").client = {
    setEffort: (agent: string, effort?: string) => {
      calls.push({ agent, effort });
      return Promise.resolve({ status: "accepted_by_host" });
    },
  };

  // A value that is NOT in claude's static capability set is treated as runtime-only:
  // forwarded live to the host but never persisted. ("max" is now a first-class claude
  // effort and would persist, so use an advertised-only sentinel here.)
  const result = await mgr.setAgentEffort("echo", "r", "turbo");

  expect(calls).toEqual([{ agent: "r", effort: "turbo" }]);
  expect(mgr.configOf("echo").agents[0].effort).toBeUndefined();
  // runtime-only: forwarded live, never persisted; host can only accept (not apply)
  expect(result).toEqual({ saved: false, applied: false, ackStatus: "accepted_by_host" });
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

hostTest("startMesh with fresh session strategy blanks persisted session ids before daemon start", async () => {
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
}, HOST_TEST_TIMEOUT);

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

hostTest("setMode and setModel are allowed while running", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await mgr.setMode("echo", "r", "plan");
  await mgr.setModel("echo", "r", "test-model");
  expect(mgr.listMeshes()[0].status).toBe("running");
  expect(mgr.configOf("echo").agents[0].mode).toBe("plan");
  expect(mgr.configOf("echo").agents[0].model).toBe("test-model");
}, HOST_TEST_TIMEOUT);

test("a stopped mesh saves the desired value without a live apply", async () => {
  await mgr.defineMesh(cfg);
  const result = await mgr.setMode("echo", "r", "plan");
  expect(result).toEqual({ saved: true, applied: false });
  expect(mgr.configOf("echo").agents[0].mode).toBe("plan");
});

test("setMode does not resolve until the host acks, then reports applied_by_acp", async () => {
  await mgr.defineMesh(cfg);
  let releaseAck!: (ack: { status: string }) => void;
  (mgr as any).entries.get("echo").client = {
    setMode: () => new Promise((resolve) => { releaseAck = resolve; }),
  };

  let settled = false;
  const pending = mgr.setMode("echo", "r", "plan").then((r) => { settled = true; return r; });
  await Bun.sleep(30);
  expect(settled).toBe(false); // manager must wait for the host ack, not resolve eagerly
  // desired is already persisted even though the live apply has not been acked yet
  expect(mgr.configOf("echo").agents[0].mode).toBe("plan");

  releaseAck({ status: "applied_by_acp" });
  expect(await pending).toEqual({ saved: true, applied: true, ackStatus: "applied_by_acp" });
});

test("setModel reports accepted_by_host (model writes are not tracked by ACP)", async () => {
  await mgr.defineMesh(cfg);
  (mgr as any).entries.get("echo").client = {
    setModel: () => Promise.resolve({ status: "accepted_by_host" }),
  };
  const result = await mgr.setModel("echo", "r", "test-model");
  // accepted_by_host is NOT applied: ACP does not confirm raw model writes
  expect(result).toEqual({ saved: true, applied: false, ackStatus: "accepted_by_host" });
});

test("a live apply failure is surfaced but the desired value stays persisted", async () => {
  await mgr.defineMesh(cfg);
  (mgr as any).entries.get("echo").client = {
    setMode: () => Promise.reject(new Error("host exploded")),
  };
  const result = await mgr.setMode("echo", "r", "plan");
  // not reported as success...
  expect(result.applied).toBe(false);
  expect(result.error).toMatch(/host exploded/);
  // ...but the desired value is still saved for replay on next start
  expect(result.saved).toBe(true);
  expect(mgr.configOf("echo").agents[0].mode).toBe("plan");
  const fresh = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
  await fresh.loadDefinitions();
  expect(fresh.configOf("echo").agents[0].mode).toBe("plan");
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

test("deleteMesh removes the mesh's durable board file", async () => {
  const root = await mkdtemp(join(tmpdir(), "mgr-board-root-"));
  const m = new MeshManager({ root, hostScript: FIXTURE });
  const { existsSync } = await import("node:fs");
  const boardFile = join(root, "boards", "echo.json");
  try {
    await m.defineMesh(cfg);
    await mkdir(join(root, "boards"), { recursive: true });
    await writeFile(boardFile, JSON.stringify({ mesh: "echo", revision: 1, epicSeq: 0, taskSeq: 1, epics: [], tasks: [] }));
    expect(existsSync(boardFile)).toBe(true);
    await m.deleteMesh("echo");
    expect(existsSync(boardFile)).toBe(false);
  } finally {
    await m.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("readBoard reads the durable board file for a stopped mesh", async () => {
  await mgr.defineMesh(cfg);
  await mkdir(join(dir, "boards"), { recursive: true });
  await writeFile(
    join(dir, "boards", "echo.json"),
    JSON.stringify({ mesh: "echo", revision: 1, epicSeq: 0, taskSeq: 1, epics: [], tasks: [{ id: 1, title: "persisted", status: "todo", priority: "normal", deps: [], subtasks: [], subtaskSeq: 0, revision: 1, createdBy: "x", createdAt: "T", updatedAt: "T", comments: [], mailEventIds: [] }] }),
  );
  const board = await mgr.readBoard("echo");
  expect(board.tasks).toHaveLength(1);
  expect(board.tasks[0].title).toBe("persisted");
});

test("boardCommand refuses a stopped mesh (running-only, no stopped write path)", async () => {
  await mgr.defineMesh(cfg);
  await expect(
    mgr.boardCommand("echo", { kind: "human" }, { type: "create_task", title: "x" }, 0),
  ).rejects.toThrow(/not running/i);
});

test("loadDefinitions rejects manually edited unsafe artifact names", async () => {
  await mkdir(join(dir, "meshes"), { recursive: true });
  await writeFile(
    join(dir, "meshes", "unsafe.json"),
    JSON.stringify({ ...cfg, name: "bad..mesh", agents: [{ ...cfg.agents[0]!, id: "bad/agent" }] }),
  );
  await expect(mgr.loadDefinitions()).rejects.toThrow(/invalid/i);
});

hostTest("deleteMesh refuses while running", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await expect(mgr.deleteMesh("echo")).rejects.toThrow(/running/i);
  expect(mgr.listMeshes()[0]!.status).toBe("running");
}, HOST_TEST_TIMEOUT);

hostTest("defineMesh still refuses full replacement while running", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await expect(mgr.defineMesh({ ...cfg, charter: "replace" })).rejects.toThrow(/running/i);
  expect(mgr.configOf("echo").charter).toBeUndefined();
}, HOST_TEST_TIMEOUT);

hostTest("start -> running -> promptRouter relays events -> stop -> stopped, no orphan", async () => {
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
}, HOST_TEST_TIMEOUT);

hostTest("explicit start flips meshExpectedAlive back to true", async () => {
  await mgr.defineMesh(cfg);
  const runDir = join(dir, "run");
  await writeSessionState(runDir, "echo", {
    meshExpectedAlive: false,
    agents: { r: { sessionId: "sid", cwd: "test_mesh_0", harness: "claude" } },
  });

  await mgr.startMesh("echo");

  expect((await readSessionState(runDir, "echo")).meshExpectedAlive).toBe(true);
}, HOST_TEST_TIMEOUT);

hostTest("startMesh twice errors", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await expect(mgr.startMesh("echo")).rejects.toThrow(/already running/i);
}, HOST_TEST_TIMEOUT);

hostTest("a daemon outlives the backend: reattachRunning reconnects + replays + drives it", async () => {
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
}, HOST_TEST_TIMEOUT);

hostTest("losing the host socket to a live daemon keeps the registry so start reattaches", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  const pid = mgr.pidOf("echo")!;
  const runDir = join(dir, "run");
  const rec = await readRecord(runDir, "echo");
  expect(rec).toMatchObject({ name: "echo", pid });

  // A second client simulates another backend attach/takeover. The host drops the manager's
  // socket, but the daemon process is still alive, so its root-scoped registry must remain.
  const takeover = new MeshHostClient({ name: "echo", config: cfg, socketPath: rec!.socketPath, runDir });
  await takeover.attach(rec!);
  for (let i = 0; i < 50 && mgr.listMeshes()[0]!.status !== "dead"; i++) await Bun.sleep(20);
  expect(mgr.listMeshes()[0]!.status).toBe("dead");
  expect(await readRecord(runDir, "echo")).toMatchObject({ name: "echo", pid });
  expect(existsSync(rec!.socketPath)).toBe(true);

  takeover.disconnect();
  await mgr.startMesh("echo");
  expect(mgr.listMeshes()[0]!.status).toBe("running");
  expect(mgr.pidOf("echo")).toBe(pid);

  await mgr.stopMesh("echo");
  await waitForPidExit(pid);
}, HOST_TEST_TIMEOUT);

hostTest("a crashed mesh host is reaped: status dead, socket file removed, restartable", async () => {
  const CRASH = join(import.meta.dir, "fixtures", "crash-host.ts");
  const crashMgr = new MeshManager({ meshesDir: join(dir, "meshes2"), runDir: join(dir, "run2"), hostScript: CRASH });
  await crashMgr.defineMesh(cfg);
  await crashMgr.startMesh("echo");           // resolves on ready
  // wait for the self-exit to be observed
  await Bun.sleep(400);
  expect(crashMgr.listMeshes()[0]!.status).toBe("dead");
  // socket file should be gone
  const sock = meshSocketPath(join(dir, "run2"), "echo");
  const { existsSync } = await import("node:fs");
  expect(existsSync(sock)).toBe(false);
  await crashMgr.stopAll();
}, HOST_TEST_TIMEOUT);

hostTest("startMesh resets status to stopped when the host fails to start", async () => {
  await mgr.defineMesh(cfg);
  // point at a nonexistent host script so the child exits before ready
  const bad = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: join(dir, "nope.ts") });
  await bad.defineMesh(cfg);
  await expect(bad.startMesh("echo")).rejects.toThrow();
  expect(bad.listMeshes()[0]!.status).toBe("stopped");
  // and it can be retried (not stuck on "already running")
  await expect(bad.startMesh("echo")).rejects.toThrow();
}, HOST_TEST_TIMEOUT);

// ── mergeDefinitionsFromDisk (feishu-mesh-watch-sync Blocker 2) ──

test("mergeDefinitionsFromDisk adds only missing meshes and never replaces an existing entry", async () => {
  await mgr.defineMesh(cfg); // "echo" in memory (stopped) + persisted to disk (harness claude)
  // a NEW mesh appears only on disk (CLI / hand-edit)
  await writeFile(join(dir, "meshes", "extra.json"), JSON.stringify({ name: "extra", agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }], edges: [] }));
  // the EXISTING mesh's file is changed on disk — merge must NOT pick it up (skip existing)
  await writeFile(join(dir, "meshes", "echo.json"), JSON.stringify({ name: "echo", agents: [{ id: "r", harness: "codex", project: "test_mesh_0", role: "router" }], edges: [] }));
  await mgr.mergeDefinitionsFromDisk();
  expect(mgr.listMeshes().map((m) => m.name).sort()).toEqual(["echo", "extra"]); // missing "extra" added
  expect(mgr.configOf("echo").agents[0].harness).toBe("claude"); // existing entry untouched (not the disk's codex)
});

hostTest("mergeDefinitionsFromDisk preserves an existing RUNNING mesh's status and adds the new one stopped", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  expect(mgr.listMeshes()[0].status).toBe("running");
  await writeFile(join(dir, "meshes", "extra.json"), JSON.stringify({ name: "extra", agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }], edges: [] }));
  await mgr.mergeDefinitionsFromDisk();
  const list = mgr.listMeshes();
  expect(list.find((m) => m.name === "echo")!.status).toBe("running"); // live entry NOT clobbered to stopped
  expect(list.find((m) => m.name === "extra")!.status).toBe("stopped"); // new file-only mesh added stopped
}, HOST_TEST_TIMEOUT);
