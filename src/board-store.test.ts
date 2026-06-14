import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBoardCommand, computeBoardWarnings, createEmptyBoard, type BoardState } from "./board";
import { assertSafeBoardName, boardPath, boardsDirFor, deleteBoard, readBoard, withBoardLock, writeBoard } from "./board-store";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "board-store-"));
}

function seeded(mesh: string): BoardState {
  let state = createEmptyBoard(mesh);
  const res = applyBoardCommand(
    state,
    { type: "create_task", title: "first" },
    { actor: { kind: "router", agentId: "lead" }, now: "2026-06-14T00:00:00.000Z", expectedBoardRevision: state.revision },
  );
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

test("read drops malformed entities, dedups ids, normalizes status/revision/seq", async () => {
  const dir = await tmp();
  try {
    await writeFile(
      join(dir, "m.json"),
      JSON.stringify({
        revision: "bad", // invalid → 0
        taskSeq: 1, // less than retained max id → normalized up
        epics: [null, { id: "epic-2", seq: 2 }, "nope"],
        tasks: [
          null,
          { id: 5, status: "weird", revision: -3 }, // invalid status → todo, revision → 1
          { id: 5, title: "dup" }, // duplicate id → dropped
          { id: 9, deps: [9, 2, "x", -1], subtasks: undefined, comments: 42, mailEventIds: ["m1", "m1", 7] },
          { title: "no id" }, // unaddressable → dropped
        ],
      }),
      "utf8",
    );
    const board = await readBoard(dir, "m");

    expect(board.revision).toBe(0);
    expect(board.epics.map((e) => e.id)).toEqual(["epic-2"]);
    expect(board.tasks.map((t) => t.id)).toEqual([5, 9]);
    expect(board.taskSeq).toBe(9); // normalized above the retained max id
    expect(board.epicSeq).toBe(2);

    const t5 = board.tasks.find((t) => t.id === 5)!;
    expect(t5.status).toBe("todo");
    expect(t5.revision).toBe(1);
    expect(t5.priority).toBe("normal");
    expect(Array.isArray(t5.subtasks)).toBe(true);
    expect(Array.isArray(t5.comments)).toBe(true);

    const t9 = board.tasks.find((t) => t.id === 9)!;
    expect(t9.deps).toEqual([2]); // self-ref 9 dropped, non-ints/negatives dropped
    expect(t9.subtasks).toEqual([]);
    expect(t9.comments).toEqual([]);
    expect(t9.mailEventIds).toEqual(["m1"]); // deduped, non-strings dropped

    // derived helpers must not crash on the sanitized board, and surface the dangling dep
    expect(() => computeBoardWarnings(board)).not.toThrow();
    const warns = computeBoardWarnings(board);
    expect(warns.some((w) => w.kind === "missing_dependency" && w.taskId === 9 && w.dependsOn === 2)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read drops persisted ids that violate the locked epic-N / taskId.n shapes", async () => {
  const dir = await tmp();
  try {
    await writeFile(
      join(dir, "m.json"),
      JSON.stringify({
        epics: [
          { id: "epic-2", seq: 99 }, // valid; seq derived from id (2), not the bogus 99
          { id: "not-epic", seq: 3 }, // malformed id → dropped
          { id: "epic-x" }, // malformed id → dropped
        ],
        tasks: [
          {
            id: 5,
            subtasks: [
              { id: "5.1", title: "ok" }, // valid
              { id: "bad-sub", title: "nope" }, // malformed → dropped
              { id: "9.2", title: "wrong parent" }, // belongs to #9, not #5 → dropped
            ],
          },
        ],
      }),
      "utf8",
    );
    const board = await readBoard(dir, "m");

    expect(board.epics.map((e) => e.id)).toEqual(["epic-2"]);
    expect(board.epics[0].seq).toBe(2); // derived from the id, not the persisted 99
    expect(board.epicSeq).toBe(2); // normalized from retained valid ids only

    const t5 = board.tasks.find((t) => t.id === 5)!;
    expect(t5.subtasks.map((s) => s.id)).toEqual(["5.1"]);
    expect(t5.subtaskSeq).toBe(1); // derived from retained valid subtask suffix
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
