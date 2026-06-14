import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBoardCommand, createEmptyBoard, type BoardState } from "./board";
import { assertSafeBoardName, boardPath, boardsDirFor, deleteBoard, readBoard, withBoardLock, writeBoard } from "./board-store";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "board-store-"));
}

function seeded(mesh: string): BoardState {
  let state = createEmptyBoard(mesh);
  const res = applyBoardCommand(state, { type: "create_task", title: "first" }, { actor: { kind: "router", agentId: "lead" }, now: "2026-06-14T00:00:00.000Z" });
  if (res.ok) state = res.state;
  return state;
}

test("boardsDirFor + boardPath compose the <root>/boards/<mesh>.json path", () => {
  const dir = boardsDirFor("/data/.agent-mesh");
  expect(dir).toBe("/data/.agent-mesh/boards");
  expect(boardPath(dir, "mesh-dev")).toBe("/data/.agent-mesh/boards/mesh-dev.json");
});

test("read returns an empty board when no file exists", async () => {
  const dir = await tmp();
  try {
    const board = await readBoard(dir, "ghost");
    expect(board).toEqual(createEmptyBoard("ghost"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write then read round-trips the board state", async () => {
  const dir = await tmp();
  try {
    const state = seeded("m");
    await writeBoard(dir, "m", state);
    const back = await readBoard(dir, "m");
    expect(back).toEqual(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write is atomic: it leaves no .tmp files behind", async () => {
  const dir = await tmp();
  try {
    await writeBoard(dir, "m", seeded("m"));
    const boardsDir = dir; // writeBoard writes directly into the dir we passed
    const files = await readdir(boardsDir);
    expect(files).toContain("m.json");
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete removes the board file and is a no-op when absent", async () => {
  const dir = await tmp();
  try {
    await writeBoard(dir, "m", seeded("m"));
    await deleteBoard(dir, "m");
    expect(await readdir(dir)).not.toContain("m.json");
    // second delete (file gone) does not throw
    await deleteBoard(dir, "m");
    // undefined dir is a no-op
    await deleteBoard(undefined, "m");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid / traversal mesh names are rejected", () => {
  expect(() => assertSafeBoardName("../etc")).toThrow();
  expect(() => assertSafeBoardName("a/b")).toThrow();
  expect(() => assertSafeBoardName("")).toThrow();
  expect(() => assertSafeBoardName("..")).toThrow();
  expect(() => boardPath("/x", "..")).toThrow();
  expect(() => assertSafeBoardName("ok.mesh-1")).not.toThrow();
});

test("a corrupt board file reads back as an empty board instead of throwing", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "m.json"), "{ not json", "utf8");
    const board = await readBoard(dir, "m");
    expect(board).toEqual(createEmptyBoard("m"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read sanitizes a partial file and recovers epicSeq/taskSeq from contents", async () => {
  const dir = await tmp();
  try {
    await writeFile(
      join(dir, "m.json"),
      JSON.stringify({ epics: [{ id: "epic-3", seq: 3 }], tasks: [{ id: 7 }, { id: 4 }] }),
      "utf8",
    );
    const board = await readBoard(dir, "m");
    expect(board.epicSeq).toBe(3);
    expect(board.taskSeq).toBe(7);
    expect(board.mesh).toBe("m");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withBoardLock serializes concurrent writers on the same path", async () => {
  const order: string[] = [];
  const path = "/virtual/lock-path";
  const a = withBoardLock(path, async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a-end");
  });
  const b = withBoardLock(path, async () => {
    order.push("b-start");
    order.push("b-end");
  });
  await Promise.all([a, b]);
  // b must not start until a finishes.
  expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
});

test("concurrent writeBoard calls do not corrupt the file (last write wins, valid JSON)", async () => {
  const dir = await tmp();
  try {
    const writes = Array.from({ length: 8 }, (_, i) => {
      const s = createEmptyBoard("m");
      s.revision = i + 1;
      return writeBoard(dir, "m", s);
    });
    await Promise.all(writes);
    const raw = await readFile(join(dir, "m.json"), "utf8");
    const parsed = JSON.parse(raw); // must be valid JSON, not interleaved
    expect(typeof parsed.revision).toBe("number");
    expect(parsed.mesh).toBe("m");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
