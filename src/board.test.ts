import { expect, test } from "bun:test";
import {
  applyBoardCommand,
  computeBoardWarnings,
  computeCloseReadiness,
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

/** Phase 0: only privileged actors create tasks, so the default creator is the router. */
function seedTask(state: BoardState, actor: BoardActor = router): { state: BoardState; id: number } {
  const next = ok(state, { type: "create_task", title: "do a thing" }, actor);
  return { state: next, id: next.taskSeq };
}

/** Seed a task already assigned to `assignee` (router creates + assigns). */
function seedAssigned(state: BoardState, assignee: string): { state: BoardState; id: number } {
  const created = ok(state, { type: "create_task", title: "owned", assignee }, router);
  return { state: created, id: created.taskSeq };
}

// ── creation / structural permissions ────────────────────────────────────────

test("create_epic is router/human-only; agents are forbidden", () => {
  const board = createEmptyBoard("m");
  const denied = applyBoardCommand(board, { type: "create_epic", title: "Big" }, ctx(board, alice));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");

  const next = ok(board, { type: "create_epic", title: "Big" }, router);
  expect(next.epics[0]).toMatchObject({ id: "epic-1", seq: 1, status: "todo", revision: 1, createdBy: "lead" });
  expect(next.revision).toBe(1);
});

test("Phase 0: members may NOT create tasks (router/human only)", () => {
  const board = createEmptyBoard("m");
  for (const member of [alice, bob]) {
    const denied = applyBoardCommand(board, { type: "create_task", title: "t" }, ctx(board, member));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("forbidden");
  }
  // router + human may create, and a fresh task carries the lifecycle defaults.
  const r = ok(board, { type: "create_task", title: "t" }, router);
  expect(r.tasks[0]).toMatchObject({ id: 1, status: "todo", createdBy: "lead", closeReady: false });
  expect(r.tasks[0].lifecycleEvents).toEqual([]);
  expect(r.tasks[0].labelIds).toEqual([]);
  expect(ok(board, { type: "create_task", title: "t2", priority: "urgent", assignee: "alice" }, human).tasks[0]).toMatchObject({ priority: "urgent", assignee: "alice" });
});

test("epic membership / reparent is router-only", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_epic", title: "E" }, router); // epic-1
  board = ok(board, { type: "create_task", title: "t" }, router); // #1
  const reparent = applyBoardCommand(board, { type: "update_task", id: 1, expectedRevision: 1, epicId: "epic-1" }, ctx(board, alice));
  expect(reparent.ok).toBe(false);
  if (!reparent.ok) expect(reparent.code).toBe("forbidden");
  board = ok(board, { type: "update_task", id: 1, expectedRevision: 1, epicId: "epic-1" }, router);
  expect(board.tasks[0].epicId).toBe("epic-1");
});

test("assign and priority are router/human-only", () => {
  const { state, id } = seedTask(createEmptyBoard("m"));
  expect(applyBoardCommand(state, { type: "assign_task", id, expectedRevision: 1, assignee: "bob" }, ctx(state, alice)).ok).toBe(false);
  expect(applyBoardCommand(state, { type: "set_task_priority", id, expectedRevision: 1, priority: "high" }, ctx(state, bob)).ok).toBe(false);
  expect(ok(state, { type: "set_task_priority", id, expectedRevision: 1, priority: "high" }, router).tasks[0].priority).toBe("high");
});

// ── status / ownership ─────────────────────────────────────────────────────────

test("assignee may progress an owned task up to in_review but never to done/cancelled", () => {
  let { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  const rev = () => state.tasks[0].revision;
  state = ok(state, { type: "set_task_status", id, expectedRevision: rev(), status: "in_progress" }, alice);
  state = ok(state, { type: "set_task_status", id, expectedRevision: rev(), status: "in_review" }, alice);

  const toDone = applyBoardCommand(state, { type: "set_task_status", id, expectedRevision: rev(), status: "done" }, ctx(state, alice));
  expect(toDone.ok).toBe(false);
  if (!toDone.ok) expect(toDone.code).toBe("forbidden");
  expect(applyBoardCommand(state, { type: "set_task_status", id, expectedRevision: rev(), status: "cancelled" }, ctx(state, alice)).ok).toBe(false);

  expect(ok(state, { type: "set_task_status", id, expectedRevision: rev(), status: "done" }, router).tasks[0].status).toBe("done");
});

test("a non-owner agent cannot change another agent's assigned task status", () => {
  const { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  const denied = applyBoardCommand(state, { type: "set_task_status", id, expectedRevision: state.tasks[0].revision, status: "in_progress" }, ctx(state, bob));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");
});

// ── subtasks scoped to the owned (parent) task ───────────────────────────────

test("member subtask create/update is scoped to a task it owns; others are read-only", () => {
  let { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  // non-owner bob cannot add a subtask
  const bobDenied = applyBoardCommand(state, { type: "create_subtask", taskId: id, expectedRevision: state.tasks[0].revision, title: "s" }, ctx(state, bob));
  expect(bobDenied.ok).toBe(false);
  if (!bobDenied.ok) expect(bobDenied.code).toBe("forbidden");
  // owner alice can
  state = ok(state, { type: "create_subtask", taskId: id, expectedRevision: state.tasks[0].revision, title: "s" }, alice);
  expect(state.tasks[0].subtasks[0]).toMatchObject({ id: "1.1", createdBy: "alice" });
  // owner can update + advance subtask status to in_review; non-owner cannot
  state = ok(state, { type: "set_subtask_status", taskId: id, subtaskId: "1.1", expectedRevision: 1, status: "in_review" }, alice);
  expect(state.tasks[0].subtasks[0].status).toBe("in_review");
  const bobStatus = applyBoardCommand(state, { type: "set_subtask_status", taskId: id, subtaskId: "1.1", expectedRevision: 2, status: "in_progress" }, ctx(state, bob));
  expect(bobStatus.ok).toBe(false);
});

test("create_subtask requires parent task CAS (missing → invalid, stale → conflict)", () => {
  const { state, id } = seedTask(createEmptyBoard("m")); // router task, revision 1
  const missing = applyBoardCommand(state, { type: "create_subtask", taskId: id, title: "s" } as unknown as BoardCommand, ctx(state, router));
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.code).toBe("invalid");
  const stale = applyBoardCommand(state, { type: "create_subtask", taskId: id, expectedRevision: 99, title: "s" }, ctx(state, router));
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.code).toBe("conflict");
  const okState = ok(state, { type: "create_subtask", taskId: id, expectedRevision: 1, title: "s" }, router);
  expect(okState.tasks[0].revision).toBe(2);
});

// ── comments: privileged or owner only ────────────────────────────────────────

test("comments require owner-or-privileged; a non-owner member is forbidden; append-only + entity CAS", () => {
  let { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  // non-owner bob cannot comment
  const bobDenied = applyBoardCommand(state, { type: "add_comment", target: { kind: "task", id }, expectedRevision: state.tasks[0].revision, text: "hi" }, ctx(state, bob));
  expect(bobDenied.ok).toBe(false);
  if (!bobDenied.ok) expect(bobDenied.code).toBe("forbidden");
  // wrong entity revision is a conflict (owner)
  const stale = applyBoardCommand(state, { type: "add_comment", target: { kind: "task", id }, expectedRevision: 99, text: "x" }, ctx(state, alice));
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.code).toBe("conflict");
  // owner + human may comment
  state = ok(state, { type: "add_comment", target: { kind: "task", id }, expectedRevision: state.tasks[0].revision, text: "looking" }, alice, "2026-06-14T01:00:00.000Z");
  state = ok(state, { type: "add_comment", target: { kind: "task", id }, expectedRevision: state.tasks[0].revision, text: "ok" }, human, "2026-06-14T02:00:00.000Z");
  expect(state.tasks[0].comments).toEqual([
    { author: "alice", text: "looking", ts: "2026-06-14T01:00:00.000Z" },
    { author: "operator", text: "ok", ts: "2026-06-14T02:00:00.000Z" },
  ]);
});

test("epic comments are router/operator-only", () => {
  let board = ok(createEmptyBoard("m"), { type: "create_epic", title: "E" }, router);
  const denied = applyBoardCommand(board, { type: "add_comment", target: { kind: "epic", id: "epic-1" }, expectedRevision: 1, text: "x" }, ctx(board, alice));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");
  board = ok(board, { type: "add_comment", target: { kind: "epic", id: "epic-1" }, expectedRevision: 1, text: "noted" }, router);
  expect(board.epics[0].comments).toHaveLength(1);
});

// ── CAS policy: structural board-CAS vs entity-only CAS ────────────────────────

test("structural creates gate on board revision (stale board token → conflict)", () => {
  const board = createEmptyBoard("m");
  const stale = applyBoardCommand(board, { type: "create_task", title: "t" }, { actor: router, now: NOW, expectedBoardRevision: 5 });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.code).toBe("conflict");
  const omitted = applyBoardCommand(board, { type: "create_epic", title: "E" }, { actor: router, now: NOW, expectedBoardRevision: undefined as unknown as number });
  expect(omitted.ok).toBe(false);
  if (!omitted.ok) expect(omitted.code).toBe("invalid");
});

test("entity edits ignore the board revision and gate only on the entity revision", () => {
  const { state, id } = seedAssigned(createEmptyBoard("m"), "alice"); // board rev is now 2
  // A deliberately stale board token is fine for an entity edit; only the entity revision matters.
  const goodEntityStaleBoard = applyBoardCommand(state, { type: "set_task_status", id, expectedRevision: state.tasks[0].revision, status: "in_progress" }, { actor: alice, now: NOW, expectedBoardRevision: 0 });
  expect(goodEntityStaleBoard.ok).toBe(true);
  // ...but a stale ENTITY revision still conflicts.
  const staleEntity = applyBoardCommand(state, { type: "set_task_status", id, expectedRevision: 999, status: "in_progress" }, { actor: alice, now: NOW, expectedBoardRevision: 0 });
  expect(staleEntity.ok).toBe(false);
  if (!staleEntity.ok) expect(staleEntity.code).toBe("conflict");
  // omitting the entity revision is still invalid.
  const missing = applyBoardCommand(state, { type: "set_task_status", id, status: "in_progress" } as unknown as BoardCommand, ctx(state, alice));
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.code).toBe("invalid");
});

test("entity CAS isolation: concurrent edits to DIFFERENT tasks never false-conflict", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_task", title: "A", assignee: "alice" }, router); // #1
  board = ok(board, { type: "create_task", title: "B", assignee: "bob" }, router); // #2, board rev now 2
  // Both clients last saw board rev 1 (before the other's create) but edit their own task.
  const t1 = board.tasks.find((t) => t.id === 1)!.revision;
  const t2 = board.tasks.find((t) => t.id === 2)!.revision;
  const a = applyBoardCommand(board, { type: "set_task_status", id: 1, expectedRevision: t1, status: "in_progress" }, { actor: alice, now: NOW, expectedBoardRevision: 1 });
  expect(a.ok).toBe(true);
  const b = applyBoardCommand(a.ok ? a.state : board, { type: "set_task_status", id: 2, expectedRevision: t2, status: "in_progress" }, { actor: bob, now: NOW, expectedBoardRevision: 1 });
  expect(b.ok).toBe(true); // neither 409s despite a stale board token
});

// ── lifecycle events / automatic status reflux ─────────────────────────────────

test("lifecycle: dispatched/branch_created/accepted → in_progress; review_requested → in_review", () => {
  for (const kind of ["dispatched", "branch_created", "accepted"] as const) {
    const { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
    const actor = kind === "dispatched" ? router : alice; // dispatched is privileged
    const next = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind }, actor);
    expect(next.tasks[0].status).toBe("in_progress");
    expect(next.tasks[0].lifecycleEvents?.at(-1)).toMatchObject({ kind });
  }
  const { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  const reviewed = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "review_requested" }, alice);
  expect(reviewed.tasks[0].status).toBe("in_review");
});

test("lifecycle permission: privileged-only kinds reject members; assignee kinds reject non-owners", () => {
  const { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  const rev = state.tasks[0].revision;
  // member cannot emit privileged kinds
  for (const kind of ["dispatched", "integration_ready", "reopened"] as const) {
    const denied = applyBoardCommand(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: rev, kind }, ctx(state, alice));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("forbidden");
  }
  // non-assignee member cannot emit assignee kinds
  const bobDenied = applyBoardCommand(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: rev, kind: "review_requested" }, ctx(state, bob));
  expect(bobDenied.ok).toBe(false);
  if (!bobDenied.ok) expect(bobDenied.code).toBe("forbidden");
});

test("lifecycle is monotonic: a late/out-of-order event never regresses, never reaches terminal", () => {
  let { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "review_requested" }, alice); // in_review
  // a late "dispatched" (would map to in_progress) must NOT pull it back
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "dispatched", threadKey: "late" }, router);
  expect(state.tasks[0].status).toBe("in_review");
  // close it, then a forward lifecycle event must NOT move a terminal task
  state = ok(state, { type: "set_task_status", id, expectedRevision: state.tasks[0].revision, status: "done" }, router);
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "review_requested", threadKey: "after-done" }, alice);
  expect(state.tasks[0].status).toBe("done");
});

test("lifecycle is idempotent on (taskId, kind, threadKey)", () => {
  let { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "review_requested", threadKey: "slug-1" }, alice);
  const revAfter = state.tasks[0].revision;
  const eventsAfter = state.tasks[0].lifecycleEvents?.length;
  // a repeat with the same key is a no-op
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: revAfter, kind: "review_requested", threadKey: "slug-1" }, alice);
  expect(state.tasks[0].revision).toBe(revAfter);
  expect(state.tasks[0].lifecycleEvents?.length).toBe(eventsAfter);
});

test("integration_ready sets closeReady but does NOT auto-advance to done", () => {
  let { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "review_requested" }, alice); // in_review
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "integration_ready" }, router);
  expect(state.tasks[0].status).toBe("in_review"); // NOT done
  expect(state.tasks[0].closeReady).toBe(true);
});

test("reopened is privileged and is the only sanctioned backward move (→ in_progress, clears closeReady)", () => {
  let { state, id } = seedAssigned(createEmptyBoard("m"), "alice");
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "integration_ready" }, router);
  state = ok(state, { type: "set_task_status", id, expectedRevision: state.tasks[0].revision, status: "done" }, router);
  const memberReopen = applyBoardCommand(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "reopened" }, ctx(state, alice));
  expect(memberReopen.ok).toBe(false);
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "reopened" }, router);
  expect(state.tasks[0].status).toBe("in_progress");
  expect(state.tasks[0].closeReady).toBe(false);
});

// ── computeCloseReadiness ──────────────────────────────────────────────────────

test("computeCloseReadiness flags open subtasks, incomplete deps, and missing integration_ready", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_task", title: "dep", assignee: "alice" }, router); // #1
  board = ok(board, { type: "create_task", title: "main", assignee: "alice" }, router); // #2
  board = ok(board, { type: "set_task_deps", id: 2, expectedRevision: board.tasks[1].revision, deps: [1] }, router);
  board = ok(board, { type: "create_subtask", taskId: 2, expectedRevision: board.tasks[1].revision, title: "s" }, router);

  let r = computeCloseReadiness(board, 2);
  expect(r).toMatchObject({ ready: false, openSubtasks: 1, blockingDeps: [1], hasIntegrationReady: false });

  // finish the subtask + the dep, then mark integration_ready → ready
  board = ok(board, { type: "set_subtask_status", taskId: 2, subtaskId: "2.1", expectedRevision: 1, status: "done" }, router);
  board = ok(board, { type: "set_task_status", id: 1, expectedRevision: board.tasks[0].revision, status: "done" }, router);
  board = ok(board, { type: "record_lifecycle_event", taskId: 2, expectedRevision: board.tasks[1].revision, kind: "integration_ready" }, router);
  r = computeCloseReadiness(board, 2);
  expect(r).toMatchObject({ ready: true, openSubtasks: 0, blockingDeps: [], hasIntegrationReady: true });
});

// ── retained coverage (DAG, progress, link_mail, misc) ─────────────────────────

test("DAG warnings: blocked-by-incomplete is advisory and a cycle is reported once", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_task", title: "A" }, router); // #1
  board = ok(board, { type: "create_task", title: "B" }, router); // #2
  board = ok(board, { type: "set_task_deps", id: 2, expectedRevision: 1, deps: [1] }, router);
  board = ok(board, { type: "set_task_status", id: 2, expectedRevision: 2, status: "in_progress" }, router);
  expect(computeBoardWarnings(board).some((w) => w.kind === "blocked_by_incomplete" && w.taskId === 2)).toBe(true);
  board = ok(board, { type: "set_task_deps", id: 1, expectedRevision: 1, deps: [2] }, router);
  const cycles = computeBoardWarnings(board).filter((w) => w.kind === "dependency_cycle");
  expect(cycles).toHaveLength(1);
});

test("parent progress: task progress derives from subtasks; epic from tasks", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_epic", title: "Epic" }, router); // epic-1
  board = ok(board, { type: "create_task", title: "T1", epicId: "epic-1" }, router); // #1
  board = ok(board, { type: "create_subtask", taskId: 1, expectedRevision: 1, title: "s1" }, router);
  board = ok(board, { type: "create_subtask", taskId: 1, expectedRevision: 2, title: "s2" }, router);
  expect(taskProgress(board.tasks[0])).toMatchObject({ done: 0, total: 2, ratio: 0 });
  board = ok(board, { type: "set_subtask_status", taskId: 1, subtaskId: "1.1", expectedRevision: 1, status: "done" }, router);
  expect(taskProgress(board.tasks.find((t) => t.id === 1)!)).toMatchObject({ done: 1, total: 2, ratio: 0.5 });
  board = ok(board, { type: "create_task", title: "T2", epicId: "epic-1" }, router); // #2
  board = ok(board, { type: "set_task_status", id: 2, expectedRevision: 1, status: "done" }, router);
  expect(epicProgress(board, "epic-1")).toMatchObject({ done: 1, total: 2, ratio: 0.5 });
});

test("deleting an epic orphans its tasks rather than cascading", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_epic", title: "E" }, router); // epic-1
  board = ok(board, { type: "create_task", title: "T", epicId: "epic-1" }, router); // #1
  board = ok(board, { type: "delete_epic", id: "epic-1", expectedRevision: 1 }, router);
  expect(board.epics).toHaveLength(0);
  expect(board.tasks[0].epicId).toBeUndefined();
});

test("link_mail is system-only and idempotent; agents cannot call it", () => {
  let { state, id } = seedTask(createEmptyBoard("m"));
  const denied = applyBoardCommand(state, { type: "link_mail", taskId: id, expectedRevision: 1, mailEventId: "mail-1" }, ctx(state, alice));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");
  state = ok(state, { type: "link_mail", taskId: id, expectedRevision: 1, mailEventId: "mail-1" }, system);
  const rev = state.tasks[0].revision;
  state = ok(state, { type: "link_mail", taskId: id, expectedRevision: rev, mailEventId: "mail-1" }, system);
  expect(state.tasks[0].mailEventIds).toEqual(["mail-1"]);
  expect(state.tasks[0].revision).toBe(rev); // idempotent no-op
});

test("deps must reference existing tasks and a missing dep is rejected", () => {
  const { state, id } = seedTask(createEmptyBoard("m"));
  const bad = applyBoardCommand(state, { type: "set_task_deps", id, expectedRevision: 1, deps: [999] }, ctx(state, router));
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.code).toBe("not_found");
});

test("an unknown command type returns a structured invalid result (no undefined)", () => {
  const board = createEmptyBoard("m");
  const res = applyBoardCommand(board, { type: "bogus_command", id: 1 } as unknown as BoardCommand, ctx(board, router));
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.code).toBe("invalid");
    expect(res.error).toContain("unknown board command");
  }
});

test("not_found is returned for operations on missing entities", () => {
  const board = createEmptyBoard("m");
  const res = applyBoardCommand(board, { type: "set_task_status", id: 7, expectedRevision: 1, status: "done" }, ctx(board, router));
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe("not_found");
});
