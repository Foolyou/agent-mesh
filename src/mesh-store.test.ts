// src/mesh-store.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshStore } from "./mesh-store";
import type { MeshConfig } from "./acp/types";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "meshstore-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const cfg: MeshConfig = {
  name: "alpha",
  agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }],
  edges: [],
};

test("define then load round-trips the config", async () => {
  const store = new MeshStore(dir);
  await store.define(cfg);
  const loaded = await store.load();
  expect(loaded).toEqual([cfg]);
});

test("define and load normalize old tuple edges at the persistence boundary", async () => {
  const store = new MeshStore(dir);
  await store.define({ ...cfg, agents: [...cfg.agents, { id: "m", harness: "codex", project: "test_mesh_0", role: "member" }], edges: [["r", "m"]] as any });
  expect(JSON.parse(await readFile(join(dir, "alpha.json"), "utf8")).edges).toEqual([{ from: "r", to: "m", steer: false }]);

  await writeFile(
    join(dir, "legacy.json"),
    JSON.stringify({ ...cfg, name: "legacy", agents: [...cfg.agents, { id: "m", harness: "codex", project: "test_mesh_0", role: "member" }], edges: [["r", "m"]] }),
  );
  const legacy = (await store.load()).find((m) => m.name === "legacy");
  expect(legacy?.edges).toEqual([{ from: "r", to: "m", steer: false }]);
});

test("define validates before writing", async () => {
  const store = new MeshStore(dir);
  await expect(store.define({ ...cfg, agents: [] })).rejects.toThrow(/at least one/i);
  expect(await store.load()).toEqual([]);
});

test("load on an empty/missing dir returns []", async () => {
  const store = new MeshStore(join(dir, "nope"));
  expect(await store.load()).toEqual([]);
});

test("delete removes the definition; deleting a missing one is a no-op", async () => {
  const store = new MeshStore(dir);
  await store.define(cfg);
  await store.delete("alpha");
  expect(await store.load()).toEqual([]);
  await store.delete("alpha"); // idempotent — does not throw
});

test("delete rejects path-traversal names (filesystem boundary)", async () => {
  const store = new MeshStore(dir);
  await expect(store.delete("../../etc/passwd")).rejects.toThrow(/invalid mesh name/i);
  await expect(store.delete("..")).rejects.toThrow(/invalid mesh name/i);
  await expect(store.delete("a/b")).rejects.toThrow(/invalid mesh name/i);
});
