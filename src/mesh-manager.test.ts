// src/mesh-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
