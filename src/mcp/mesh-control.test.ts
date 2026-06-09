// src/mcp/mesh-control.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshManager } from "../mesh-manager";
import { createMeshControlHandlers } from "./mesh-control";
import { readSessionState, writeSessionState } from "../session-storage";
import type { MeshConfig } from "../acp/types";

const cfg: MeshConfig = {
  name: "echo",
  agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }],
  edges: [],
};
const FIXTURE = join(import.meta.dir, "..", "fixtures", "echo-host.ts");

let dir: string;
let mgr: MeshManager;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ctl-"));
  mgr = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
});
afterEach(async () => { await mgr.stopAll(); await rm(dir, { recursive: true, force: true }); });

test("create -> start -> list -> stop via handlers", async () => {
  const h = createMeshControlHandlers(mgr);
  expect(await h.createMesh(cfg)).toMatch(/created mesh "echo"/i);
  expect(await h.startMesh("echo")).toMatch(/started/i);
  expect(h.listMeshes()).toMatch(/echo.*running/i);
  expect(await h.stopMesh("echo")).toMatch(/stopped/i);
});

test("startMesh can request fresh sessions via handlers", async () => {
  const h = createMeshControlHandlers(mgr);
  await h.createMesh(cfg);
  await writeSessionState(join(dir, "run"), "echo", {
    meshExpectedAlive: false,
    agents: { r: { sessionId: "old", cwd: ".", harness: "claude", mailCursor: "mail-r" } },
  });

  expect(await h.startMesh("echo", "fresh")).toMatch(/fresh sessions/i);

  const rec = (await readSessionState(join(dir, "run"), "echo")).agents.r;
  expect(rec.sessionId).toBe("");
  expect(rec.mailCursor).toBe("mail-r");
});

test("createMesh returns the validation error as text (no throw)", async () => {
  const h = createMeshControlHandlers(mgr);
  expect(await h.createMesh({ ...cfg, agents: [] })).toMatch(/error.*at least one/i);
});

test("getMesh returns config JSON; updateMesh modifies it; deleteMesh removes it", async () => {
  const h = createMeshControlHandlers(mgr);
  await h.createMesh(cfg);

  const got = h.getMesh("echo");
  expect(JSON.parse(got).agents[0].project).toBe("test_mesh_0");

  const modified: MeshConfig = {
    ...cfg,
    agents: [{ ...cfg.agents[0]!, project: "test_mesh_web" }],
    charter: "be concise",
  };
  expect(await h.updateMesh(modified)).toMatch(/updated mesh "echo"/i);
  expect(JSON.parse(h.getMesh("echo")).agents[0].project).toBe("test_mesh_web");
  expect(JSON.parse(h.getMesh("echo")).charter).toBe("be concise");

  expect(await h.deleteMesh("echo")).toMatch(/deleted mesh "echo"/i);
  expect(h.listMeshes()).toMatch(/no meshes/i);
});

test("updateMesh / deleteMesh refuse while running (errors returned as text)", async () => {
  const h = createMeshControlHandlers(mgr);
  await h.createMesh(cfg);
  await h.startMesh("echo");
  expect(await h.updateMesh(cfg)).toMatch(/error.*running/i);
  expect(await h.deleteMesh("echo")).toMatch(/error.*running/i);
  await h.stopMesh("echo");
});

test("updateMesh validates; getMesh on unknown mesh returns an error", async () => {
  const h = createMeshControlHandlers(mgr);
  await h.createMesh(cfg);
  expect(await h.updateMesh({ ...cfg, agents: [] })).toMatch(/error.*at least one/i);
  expect(h.getMesh("ghost")).toMatch(/error/i);
});
