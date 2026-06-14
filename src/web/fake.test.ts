import { expect, test } from "bun:test";
import { FakeManager } from "./fake";
import type { MeshConfig } from "../acp/types";

const cfg: MeshConfig = {
  name: "lc",
  agents: [{ id: "r", harness: "claude", project: ".", role: "router" }],
  edges: [],
};

test("FakeManager.deleteMesh clears the in-memory board so delete/recreate is not stale", async () => {
  const m = new FakeManager();
  await m.defineMesh(cfg);
  await m.startMesh("lc");

  const res = await m.boardCommand("lc", { kind: "human" }, { type: "create_task", title: "persisted" }, 0);
  expect(res.ok).toBe(true);
  expect((await m.readBoard("lc")).tasks).toHaveLength(1);

  await m.stopMesh("lc");
  await m.deleteMesh("lc");

  // recreate with the SAME name → the board must start empty, not resurface the old task
  await m.defineMesh(cfg);
  const board = await m.readBoard("lc");
  expect(board.tasks).toHaveLength(0);
  expect(board.revision).toBe(0);
});

test("FakeManager.boardCommand refuses a stopped mesh (running-only, mirrors prod)", async () => {
  const m = new FakeManager();
  await m.defineMesh(cfg); // defined but not started
  await expect(m.boardCommand("lc", { kind: "human" }, { type: "create_task", title: "x" }, 0)).rejects.toThrow(/not running/i);
});
