// src/mcp/mesh-control.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshManager } from "../mesh-manager";
import { createMeshControlHandlers } from "./mesh-control";
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

test("createMesh returns the validation error as text (no throw)", async () => {
  const h = createMeshControlHandlers(mgr);
  expect(await h.createMesh({ ...cfg, agents: [] })).toMatch(/error.*at least one/i);
});
