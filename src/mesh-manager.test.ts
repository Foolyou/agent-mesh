// src/mesh-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshManager } from "./mesh-manager";
import type { MeshConfig, MeshEvent } from "./acp/types";

const cfg: MeshConfig = {
  name: "echo",
  agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }],
  edges: [],
};
const FIXTURE = join(import.meta.dir, "fixtures", "echo-host.ts");

let dir: string;
let mgr: MeshManager;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mgr-"));
  mgr = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
});
afterEach(async () => { await mgr.stopAll(); await rm(dir, { recursive: true, force: true }); });

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

test("setAgentEffort on an unknown agent throws", async () => {
  await mgr.defineMesh(cfg);
  await expect(mgr.setAgentEffort("echo", "nope", "low")).rejects.toThrow(/no agent/i);
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

test("deleteMesh removes mesh upload bucket but keeps master uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "mgr-root-"));
  const m = new MeshManager({ root, hostScript: FIXTURE });
  const { existsSync } = await import("node:fs");
  try {
    await m.defineMesh(cfg);
    await mkdir(join(root, "uploads", "echo"), { recursive: true });
    await mkdir(join(root, "uploads", "master"), { recursive: true });
    await writeFile(join(root, "uploads", "echo", "x.png"), "x");
    await writeFile(join(root, "uploads", "master", "x.png"), "x");
    await m.deleteMesh("echo");
    expect(existsSync(join(root, "uploads", "echo"))).toBe(false);
    expect(existsSync(join(root, "uploads", "master", "x.png"))).toBe(true);
  } finally {
    await m.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("deleteMesh refuses while running", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await expect(mgr.deleteMesh("echo")).rejects.toThrow(/running/i);
  expect(mgr.listMeshes()[0]!.status).toBe("running");
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
  expect(() => process.kill(pid, 0)).toThrow();
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

  // and the fresh manager can drive the reattached daemon
  mgr2.promptAgent("echo", "r", "after");
  await Bun.sleep(150);
  expect(ev2.some((e) => e.kind === "log" && (e as any).text === "echo:after")).toBe(true);

  await mgr2.stopMesh("echo");
  expect(() => process.kill(pid, 0)).toThrow(); // now truly reaped
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
