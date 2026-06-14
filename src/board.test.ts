import { expect, test } from "bun:test";
import {
  applyBoardCommand,
  computeBoardWarnings,
  createEmptyBoard,
  epicProgress,
  taskProgress,
  type BoardActor,
  type BoardCommand,
  type BoardContext,
  type BoardState,
} from "./board";

const NOW = "2026-06-14T00:00:00.000Z";
const human: BoardActor = { kind: "human" };
const router: BoardActor = { kind: "router", agentId: "lead" };
const system: BoardActor = { kind: "system" };
const alice: BoardActor = { kind: "agent", agentId: "alice" };
const bob: BoardActor = { kind: "agent", agentId: "bob" };

/** Build a context whose board-CAS token matches the current board revision. */
function ctx(state: BoardState, actor: BoardActor, now = NOW): BoardContext {
  return { actor, now, expectedBoardRevision: state.revision };
}

/** Apply a command (board-CAS auto-matched), asserting success, returning the new state. */
function ok(state: BoardState, cmd: BoardCommand, actor: BoardActor, now = NOW): BoardState {
  const res = applyBoardCommand(state, cmd, ctx(state, actor, now));
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.error}`);
  return res.state;
}

function seedTask(state: BoardState, actor: BoardActor = alice): { state: BoardState; id: number } {
  const next = ok(state, { type: "create_task", title: "do a thing" }, actor);
  return { state: next, id: next.taskSeq };
}

test("create_epic is router/human-only; agents are forbidden", () => {
  const board = createEmptyBoard("m");
  const denied = applyBoardCommand(board, { type: "create_epic", title: "Big" }, ctx(board, alice));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");

  const next = ok(board, { type: "create_epic", title: "Big" }, router);
  expect(next.epics).toHaveLength(1);
  expect(next.epics[0]).toMatchObject({ id: "epic-1", seq: 1, status: "todo", revision: 1, createdBy: "lead" });
  expect(next.revision).toBe(1);
});

test("agents can create tasks and subtasks but cannot pre-assign or set deps", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_task", title: "task A" }, alice);
  expect(board.tasks[0]).toMatchObject({ id: 1, status: "todo", priority: "normal", createdBy: "alice", assignee: undefined });

  const preAssign = applyBoardCommand(board, { type: "create_task", title: "x", assignee: "bob" }, ctx(board, alice));
  expect(preAssign.ok).toBe(false);

  board = ok(board, { type: "create_subtask", taskId: 1, title: "sub 1" }, bob);
  expect(board.tasks[0].subtasks[0]).toMatchObject({ id: "1.1", title: "sub 1", status: "todo", createdBy: "bob" });
});

test("a non-privileged agent cannot create a high/urgent task (reject, not normalize)", () => {
  const board = createEmptyBoard("m");
  const urgent = applyBoardCommand(board, { type: "create_task", title: "x", priority: "urgent" }, ctx(board, alice));
  expect(urgent.ok).toBe(false);
  if (!urgent.ok) expect(urgent.code).toBe("forbidden");

  const high = applyBoardCommand(board, { type: "create_task", title: "x", priority: "high" }, ctx(board, bob));
  expect(high.ok).toBe(false);

  // explicit "normal" is fine for an agent, and a router may set urgent
  expect(ok(board, { type: "create_task", title: "x", priority: "normal" }, alice).tasks[0].priority).toBe("normal");
  expect(ok(board, { type: "create_task", title: "y", priority: "urgent" }, router).tasks[0].priority).toBe("urgent");
});

test("epic membership is router/human-only at create and re-parent time", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_epic", title: "E" }, router); // epic-1
  // agent cannot file a task under an epic
  const filed = applyBoardCommand(board, { type: "create_task", title: "t", epicId: "epic-1" }, ctx(board, alice));
  expect(filed.ok).toBe(false);
  if (!filed.ok) expect(filed.code).toBe("forbidden");

  // agent creates a plain task it owns, then cannot re-parent it
  board = ok(board, { type: "create_task", title: "t" }, alice); // #1
  const reparent = applyBoardCommand(board, { type: "update_task", id: 1, expectedRevision: 1, epicId: "epic-1" }, ctx(board, alice));
  expect(reparent.ok).toBe(false);
  if (!reparent.ok) expect(reparent.code).toBe("forbidden");

  // router can re-parent
  board = ok(board, { type: "update_task", id: 1, expectedRevision: 1, epicId: "epic-1" }, router);
  expect(board.tasks[0].epicId).toBe("epic-1");
});

test("agents may progress an owned task up to in_review but never to done/cancelled", () => {
  let { state, id } = seedTask(createEmptyBoard("m"), alice);
  state = ok(state, { type: "set_task_status", id, expectedRevision: 1, status: "in_progress" }, alice);
  state = ok(state, { type: "set_task_status", id, expectedRevision: 2, status: "in_review" }, alice);

  const toDone = applyBoardCommand(state, { type: "set_task_status", id, expectedRevision: 3, status: "done" }, ctx(state, alice));
  expect(toDone.ok).toBe(false);
  if (!toDone.ok) expect(toDone.code).toBe("forbidden");

  const toCancel = applyBoardCommand(state, { type: "set_task_status", id, expectedRevision: 3, status: "cancelled" }, ctx(state, alice));
  expect(toCancel.ok).toBe(false);

  const done = ok(state, { type: "set_task_status", id, expectedRevision: 3, status: "done" }, router);
  expect(done.tasks[0].status).toBe("done");
});

test("a non-owner agent cannot change another agent's assigned task status", () => {
  let { state, id } = seedTask(createEmptyBoard("m"), alice);
  state = ok(state, { type: "assign_task", id, expectedRevision: 1, assignee: "alice" }, router);
  const denied = applyBoardCommand(state, { type: "set_task_status", id, expectedRevision: 2, status: "in_progress" }, ctx(state, bob));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");
});

test("entity CAS: a stale expectedRevision is rejected with a conflict", () => {
  let { state, id } = seedTask(createEmptyBoard("m"), alice);
  state = ok(state, { type: "set_task_status", id, expectedRevision: 1, status: "in_progress" }, alice);
  // board CAS matches (auto), but the entity revision is stale → conflict
  const stale = applyBoardCommand(state, { type: "set_task_status", id, expectedRevision: 1, status: "in_review" }, ctx(state, alice));
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.code).toBe("conflict");
});

test("entity CAS: omitting expectedRevision on an existing-entity mutation is invalid", () => {
  const { state, id } = seedTask(createEmptyBoard("m"), alice);
  const missing = applyBoardCommand(
    state,
    { type: "set_task_status", id, status: "in_progress" } as unknown as BoardCommand,
    ctx(state, alice),
  );
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.code).toBe("invalid");
});

test("board CAS: omitted token is invalid; stale token is a conflict; both gate before mutation", () => {
  const { state, id } = seedTask(createEmptyBoard("m"), alice);

  const omitted = applyBoardCommand(
    state,
    { type: "set_task_status", id, expectedRevision: 1, status: "in_progress" },
    { actor: alice, now: NOW, expectedBoardRevision: undefined as unknown as number },
  );
  expect(omitted.ok).toBe(false);
  if (!omitted.ok) expect(omitted.code).toBe("invalid");

  const stale = applyBoardCommand(
    state,
    { type: "set_task_status", id, expectedRevision: 1, status: "in_progress" },
    { actor: alice, now: NOW, expectedBoardRevision: 0 },
  );
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.code).toBe("conflict");
  // the task was not mutated by the rejected attempts
  expect(state.tasks[0].status).toBe("todo");
});

test("creates carry board CAS but need no entity CAS", () => {
  const board = createEmptyBoard("m");
  const stale = applyBoardCommand(board, { type: "create_task", title: "t" }, { actor: alice, now: NOW, expectedBoardRevision: 5 });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.code).toBe("conflict");
});

test("assign and priority are router/human-only", () => {
  const { state, id } = seedTask(createEmptyBoard("m"), alice);
  expect(applyBoardCommand(state, { type: "assign_task", id, expectedRevision: 1, assignee: "bob" }, ctx(state, alice)).ok).toBe(false);
  expect(applyBoardCommand(state, { type: "set_task_priority", id, expectedRevision: 1, priority: "high" }, ctx(state, bob)).ok).toBe(false);
  const next = ok(state, { type: "set_task_priority", id, expectedRevision: 1, priority: "high" }, router);
  expect(next.tasks[0].priority).toBe("high");
});

test("deps must reference existing tasks and a missing dep is rejected", () => {
  const { state, id } = seedTask(createEmptyBoard("m"), alice);
  const bad = applyBoardCommand(state, { type: "set_task_deps", id, expectedRevision: 1, deps: [999] }, ctx(state, router));
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.code).toBe("not_found");
});

test("DAG warnings: blocked-by-incomplete is advisory, never blocks the transition", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_task", title: "A" }, router); // #1
  board = ok(board, { type: "create_task", title: "B" }, router); // #2
  board = ok(board, { type: "set_task_deps", id: 2, expectedRevision: 1, deps: [1] }, router);
  board = ok(board, { type: "set_task_status", id: 2, expectedRevision: 2, status: "in_progress" }, router);
  const warnings = computeBoardWarnings(board);
  expect(warnings.some((w) => w.kind === "blocked_by_incomplete" && w.taskId === 2 && w.dependsOn === 1)).toBe(true);
});

test("DAG warnings: a dependency cycle is detected and reported once", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_task", title: "A" }, router); // #1
  board = ok(board, { type: "create_task", title: "B" }, router); // #2
  board = ok(board, { type: "set_task_deps", id: 1, expectedRevision: 1, deps: [2] }, router);
  board = ok(board, { type: "set_task_deps", id: 2, expectedRevision: 1, deps: [1] }, router);
  const cycles = computeBoardWarnings(board).filter((w) => w.kind === "dependency_cycle");
  expect(cycles).toHaveLength(1);
  if (cycles[0].kind === "dependency_cycle") expect(cycles[0].taskIds.sort()).toEqual([1, 2]);
});

test("parent progress: task progress derives from subtasks; epic from tasks", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_epic", title: "Epic" }, router); // epic-1
  board = ok(board, { type: "create_task", title: "T1", epicId: "epic-1" }, router); // #1
  board = ok(board, { type: "create_subtask", taskId: 1, title: "s1" }, router); // 1.1
  board = ok(board, { type: "create_subtask", taskId: 1, title: "s2" }, router); // 1.2

  let task = board.tasks.find((t) => t.id === 1)!;
  expect(taskProgress(task)).toMatchObject({ done: 0, total: 2, ratio: 0 });

  board = ok(board, { type: "set_subtask_status", taskId: 1, subtaskId: "1.1", expectedRevision: 1, status: "done" }, router);
  task = board.tasks.find((t) => t.id === 1)!;
  expect(taskProgress(task)).toMatchObject({ done: 1, total: 2, ratio: 0.5 });

  board = ok(board, { type: "create_task", title: "T2", epicId: "epic-1" }, router); // #2
  board = ok(board, { type: "set_task_status", id: 2, expectedRevision: 1, status: "done" }, router);
  expect(epicProgress(board, "epic-1")).toMatchObject({ done: 1, total: 2, ratio: 0.5 });
});

test("comments require board + entity CAS, are append-only, and carry author + ts", () => {
  let { state, id } = seedTask(createEmptyBoard("m"), alice);
  // wrong entity revision is rejected
  const stale = applyBoardCommand(state, { type: "add_comment", target: { kind: "task", id }, expectedRevision: 99, text: "x" }, ctx(state, bob));
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.code).toBe("conflict");

  state = ok(state, { type: "add_comment", target: { kind: "task", id }, expectedRevision: 1, text: "looking" }, bob, "2026-06-14T01:00:00.000Z");
  state = ok(state, { type: "add_comment", target: { kind: "task", id }, expectedRevision: 2, text: "done-ish" }, human, "2026-06-14T02:00:00.000Z");
  expect(state.tasks[0].comments).toEqual([
    { author: "bob", text: "looking", ts: "2026-06-14T01:00:00.000Z" },
    { author: "operator", text: "done-ish", ts: "2026-06-14T02:00:00.000Z" },
  ]);
});

test("deleting an epic orphans its tasks rather than cascading", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_epic", title: "E" }, router); // epic-1
  board = ok(board, { type: "create_task", title: "T", epicId: "epic-1" }, router); // #1
  board = ok(board, { type: "delete_epic", id: "epic-1", expectedRevision: 1 }, router);
  expect(board.epics).toHaveLength(0);
  expect(board.tasks).toHaveLength(1);
  expect(board.tasks[0].epicId).toBeUndefined();
});

test("link_mail is system-only and idempotent; agents cannot call it", () => {
  let { state, id } = seedTask(createEmptyBoard("m"), alice);
  const denied = applyBoardCommand(state, { type: "link_mail", taskId: id, expectedRevision: 1, mailEventId: "mail-1" }, ctx(state, alice));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");

  state = ok(state, { type: "link_mail", taskId: id, expectedRevision: 1, mailEventId: "mail-1" }, system);
  const revAfterFirst = state.tasks[0].revision;
  state = ok(state, { type: "link_mail", taskId: id, expectedRevision: revAfterFirst, mailEventId: "mail-1" }, system);
  expect(state.tasks[0].mailEventIds).toEqual(["mail-1"]);
  expect(state.tasks[0].revision).toBe(revAfterFirst); // idempotent no-op
});

test("not_found is returned for operations on missing entities", () => {
  const board = createEmptyBoard("m");
  const res = applyBoardCommand(board, { type: "set_task_status", id: 7, expectedRevision: 1, status: "done" }, ctx(board, router));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe("not_found");
});
