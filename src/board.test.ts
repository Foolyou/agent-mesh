import { expect, test } from "bun:test";
import {
  applyBoardCommand,
  computeBoardWarnings,
  computeCloseReadiness,
  createEmptyBoard,
  epicProgress,
  normalizeLabelColor,
  taskProgress,
  LABEL_PALETTE,
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

// ── Phase 5: reopened-cycle idempotency + threadKey default ─────────────────────

test("Phase 5: after a privileged reopened, the same slug/thread review_requested re-fires → in_review", () => {
  let board = ok(createEmptyBoard("m"), { type: "create_task", title: "t" }, router); // #1
  board = ok(board, { type: "dispatch_task", id: 1, expectedRevision: board.tasks[0].revision, assignee: "alice", taskSlug: "s" }, router); // in_progress + slug "s"
  const rev = () => board.tasks[0].revision;

  // first review (cycle 1): in_progress → in_review
  board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: rev(), kind: "review_requested", threadKey: "s" }, alice);
  expect(board.tasks[0].status).toBe("in_review");
  // a duplicate within the SAME cycle is still a no-op (no second event, no bump)
  const revAfter = rev();
  const eventsAfter = board.tasks[0].lifecycleEvents!.length;
  board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: revAfter, kind: "review_requested", threadKey: "s" }, alice);
  expect(board.tasks[0].revision).toBe(revAfter);
  expect(board.tasks[0].lifecycleEvents!.length).toBe(eventsAfter);

  // close → done, then privileged reopened → in_progress (cycle 2 begins)
  board = ok(board, { type: "set_task_status", id: 1, expectedRevision: rev(), status: "done" }, router);
  board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: rev(), kind: "reopened" }, router);
  expect(board.tasks[0].status).toBe("in_progress");

  // the SAME slug/thread review_requested now re-fires (it was deduped pre-Phase-5) → in_review again
  board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: rev(), kind: "review_requested", threadKey: "s" }, alice);
  expect(board.tasks[0].status).toBe("in_review");
  expect(board.tasks[0].lifecycleEvents!.filter((e) => e.kind === "review_requested").length).toBe(2);
});

test("Phase 5: record_lifecycle_event threadKey defaults to the task slug when omitted", () => {
  let board = ok(createEmptyBoard("m"), { type: "create_task", title: "t" }, router);
  board = ok(board, { type: "dispatch_task", id: 1, expectedRevision: board.tasks[0].revision, assignee: "alice", taskSlug: "feat-x" }, router);
  // omit threadKey → stored as the slug; moves to in_review
  board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: board.tasks[0].revision, kind: "review_requested" }, alice);
  const ev = board.tasks[0].lifecycleEvents!.find((e) => e.kind === "review_requested")!;
  expect(ev.threadKey).toBe("feat-x");
  expect(board.tasks[0].status).toBe("in_review");
  // a second omitted-threadKey signal dedupes against the slug-defaulted one (no-op)
  const revAfter = board.tasks[0].revision;
  board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: revAfter, kind: "review_requested" }, alice);
  expect(board.tasks[0].revision).toBe(revAfter);
  // an explicit threadKey EQUAL to the slug is the same key → also a no-op
  board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: revAfter, kind: "review_requested", threadKey: "feat-x" }, alice);
  expect(board.tasks[0].revision).toBe(revAfter);
});

test("Phase 5: lifecycle auto-movement still never reaches a terminal status (explicit close only)", () => {
  let board = ok(createEmptyBoard("m"), { type: "create_task", title: "t" }, router);
  board = ok(board, { type: "dispatch_task", id: 1, expectedRevision: board.tasks[0].revision, assignee: "alice", taskSlug: "s" }, router);
  board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: board.tasks[0].revision, kind: "review_requested" }, alice);
  // integration_ready marks close-ready but never auto-advances to done
  board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: board.tasks[0].revision, kind: "integration_ready" }, router);
  expect(board.tasks[0].status).toBe("in_review");
  expect(board.tasks[0].closeReady).toBe(true);
  // no lifecycle event reaches done/cancelled — those need the explicit privileged close
  for (const kind of ["dispatched", "branch_created", "accepted", "review_requested"] as const) {
    board = ok(board, { type: "record_lifecycle_event", taskId: 1, expectedRevision: board.tasks[0].revision, kind, threadKey: `k-${kind}` }, router);
    expect(board.tasks[0].status === "done" || board.tasks[0].status === "cancelled").toBe(false);
  }
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

// ── issue-panel Phase 1: dispatch_task / set_dispatch_mail ─────────────────────

test("dispatch_task atomically assigns + sets linkage + emits `dispatched` + moves to in_progress", () => {
  const { state, id } = seedTask(createEmptyBoard("m"));
  const next = ok(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "alice", taskSlug: "my-slug" }, router);
  const task = next.tasks[0];
  expect(task.status).toBe("in_progress");
  expect(task.assignee).toBe("alice");
  expect(task.taskSlug).toBe("my-slug");
  expect(task.branchName).toBe("task/my-slug");
  expect(task.dispatch).toMatchObject({ assignee: "alice", threadKey: "my-slug", at: NOW });
  expect(task.dispatch?.mailEventId).toBeUndefined();
  const dispatched = (task.lifecycleEvents ?? []).filter((e) => e.kind === "dispatched");
  expect(dispatched.length).toBe(1);
});

test("dispatch_task is router/operator-only; a member is forbidden", () => {
  const { state, id } = seedTask(createEmptyBoard("m"));
  const denied = applyBoardCommand(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "alice", taskSlug: "s" }, ctx(state, alice));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");
});

test("dispatch_task honors an explicit branchName and requires assignee + slug", () => {
  const { state, id } = seedTask(createEmptyBoard("m"));
  const withBranch = ok(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "alice", taskSlug: "s", branchName: "task/custom" }, router);
  expect(withBranch.tasks[0].branchName).toBe("task/custom");
  const noAssignee = applyBoardCommand(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "  ", taskSlug: "s" }, ctx(state, router));
  expect(noAssignee.ok).toBe(false);
  if (!noAssignee.ok) expect(noAssignee.code).toBe("invalid");
  const noSlug = applyBoardCommand(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "alice", taskSlug: "" }, ctx(state, router));
  expect(noSlug.ok).toBe(false);
  if (!noSlug.ok) expect(noSlug.code).toBe("invalid");
});

test("duplicate dispatch (same assignee+slug) is idempotent: no second `dispatched`, no status change", () => {
  let { state, id } = seedTask(createEmptyBoard("m"));
  state = ok(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "alice", taskSlug: "s" }, router);
  const eventsAfter = state.tasks[0].lifecycleEvents?.length;
  state = ok(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "alice", taskSlug: "s" }, router);
  expect(state.tasks[0].lifecycleEvents?.length).toBe(eventsAfter); // no second dispatched event
  expect(state.tasks[0].status).toBe("in_progress");
});

test("re-assign via dispatch_task: assignee changes, a fresh `dispatched` is appended, status does NOT regress", () => {
  let { state, id } = seedTask(createEmptyBoard("m"));
  state = ok(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "alice", taskSlug: "s" }, router);
  // alice pushes the card to in_review before the re-assign
  state = ok(state, { type: "record_lifecycle_event", taskId: id, expectedRevision: state.tasks[0].revision, kind: "review_requested", threadKey: "s" }, alice);
  expect(state.tasks[0].status).toBe("in_review");
  // re-dispatch to bob: assignee flips, a new dispatched event is appended (audit), status stays in_review (monotonic)
  state = ok(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "bob", taskSlug: "s" }, router);
  expect(state.tasks[0].assignee).toBe("bob");
  expect(state.tasks[0].status).toBe("in_review");
  expect((state.tasks[0].lifecycleEvents ?? []).filter((e) => e.kind === "dispatched").length).toBe(2);
});

test("set_dispatch_mail backfills mailEventId on success and mailFailed on failure", () => {
  let { state, id } = seedTask(createEmptyBoard("m"));
  state = ok(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "alice", taskSlug: "s" }, router);
  // success path: id recorded, mailFailed cleared
  state = ok(state, { type: "set_dispatch_mail", taskId: id, expectedRevision: state.tasks[0].revision, mailEventId: "evt-1" }, system);
  expect(state.tasks[0].dispatch?.mailEventId).toBe("evt-1");
  expect(state.tasks[0].dispatch?.mailFailed).toBe(false);
  // failure path on a fresh dispatch
  let { state: s2, id: id2 } = seedTask(createEmptyBoard("m"));
  s2 = ok(s2, { type: "dispatch_task", id: id2, expectedRevision: s2.tasks[0].revision, assignee: "alice", taskSlug: "s2" }, router);
  s2 = ok(s2, { type: "set_dispatch_mail", taskId: id2, expectedRevision: s2.tasks[0].revision, mailFailed: true }, system);
  expect(s2.tasks[0].dispatch?.mailFailed).toBe(true);
  expect(s2.tasks[0].dispatch?.mailEventId).toBeUndefined();
});

test("set_dispatch_mail is privileged-only and requires an existing dispatch", () => {
  let { state, id } = seedTask(createEmptyBoard("m"));
  // no dispatch yet → invalid
  const noDispatch = applyBoardCommand(state, { type: "set_dispatch_mail", taskId: id, expectedRevision: state.tasks[0].revision, mailEventId: "x" }, ctx(state, router));
  expect(noDispatch.ok).toBe(false);
  if (!noDispatch.ok) expect(noDispatch.code).toBe("invalid");
  state = ok(state, { type: "dispatch_task", id, expectedRevision: state.tasks[0].revision, assignee: "alice", taskSlug: "s" }, router);
  const denied = applyBoardCommand(state, { type: "set_dispatch_mail", taskId: id, expectedRevision: state.tasks[0].revision, mailEventId: "x" }, ctx(state, alice));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");
});

test("dispatch_task rejects a slug already owned by a DIFFERENT task (slugs are unique)", () => {
  let board = createEmptyBoard("m");
  board = ok(board, { type: "create_task", title: "first" }, router); // #1
  board = ok(board, { type: "create_task", title: "second" }, router); // #2
  // dispatch #1 with slug "dup"
  board = ok(board, { type: "dispatch_task", id: 1, expectedRevision: board.tasks.find((t) => t.id === 1)!.revision, assignee: "alice", taskSlug: "dup" }, router);
  // dispatching #2 with the SAME slug is rejected at the write
  const clash = applyBoardCommand(board, { type: "dispatch_task", id: 2, expectedRevision: board.tasks.find((t) => t.id === 2)!.revision, assignee: "bob", taskSlug: "dup" }, ctx(board, router));
  expect(clash.ok).toBe(false);
  if (!clash.ok) {
    expect(clash.code).toBe("invalid");
    expect(clash.error).toContain("#1");
  }
  // #2 keeps no slug; #1 still owns "dup"
  expect(board.tasks.find((t) => t.id === 2)!.taskSlug).toBeUndefined();
  // a UNIQUE slug for #2 succeeds, and re-dispatching #1 with ITS OWN slug is fine (self is not a clash)
  board = ok(board, { type: "dispatch_task", id: 2, expectedRevision: board.tasks.find((t) => t.id === 2)!.revision, assignee: "bob", taskSlug: "uniq" }, router);
  board = ok(board, { type: "dispatch_task", id: 1, expectedRevision: board.tasks.find((t) => t.id === 1)!.revision, assignee: "carol", taskSlug: "dup" }, router);
  expect(board.tasks.find((t) => t.id === 1)!.assignee).toBe("carol");
  expect(board.tasks.find((t) => t.id === 2)!.taskSlug).toBe("uniq");
});

// ── issue-panel Phase 4: labels ───────────────────────────────────────────────

test("normalizeLabelColor accepts only palette colors (case-insensitive), rejects others", () => {
  expect(normalizeLabelColor(LABEL_PALETTE[0])).toBe(LABEL_PALETTE[0]);
  expect(normalizeLabelColor(LABEL_PALETTE[0].toUpperCase())).toBe(LABEL_PALETTE[0]);
  expect(normalizeLabelColor("#123456")).toBeNull(); // valid hex but not in palette
  expect(normalizeLabelColor("red")).toBeNull();
  expect(normalizeLabelColor(123)).toBeNull();
});

test("create_label is router/operator-only; validates name + palette color; allocates label-N", () => {
  let board = createEmptyBoard("m");
  const denied = applyBoardCommand(board, { type: "create_label", name: "bug", color: LABEL_PALETTE[0] }, ctx(board, alice));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");
  const noName = applyBoardCommand(board, { type: "create_label", name: "  ", color: LABEL_PALETTE[0] }, ctx(board, router));
  expect(noName.ok).toBe(false);
  if (!noName.ok) expect(noName.code).toBe("invalid");
  const badColor = applyBoardCommand(board, { type: "create_label", name: "bug", color: "#123456" }, ctx(board, router));
  expect(badColor.ok).toBe(false);
  if (!badColor.ok) expect(badColor.code).toBe("invalid");

  board = ok(board, { type: "create_label", name: "bug", color: LABEL_PALETTE[0] }, router); // label-1
  board = ok(board, { type: "create_label", name: "feat", color: LABEL_PALETTE[8] }, router); // label-2
  expect(board.labels).toEqual([
    { id: "label-1", name: "bug", color: LABEL_PALETTE[0] },
    { id: "label-2", name: "feat", color: LABEL_PALETTE[8] },
  ]);
  expect(board.labelSeq).toBe(2);
});

test("update_label renames/recolors (privileged); rejects bad color; not_found for unknown id", () => {
  let board = ok(createEmptyBoard("m"), { type: "create_label", name: "bug", color: LABEL_PALETTE[0] }, router);
  board = ok(board, { type: "update_label", id: "label-1", name: "defect", color: LABEL_PALETTE[8] }, router);
  expect(board.labels![0]).toEqual({ id: "label-1", name: "defect", color: LABEL_PALETTE[8] });
  const member = applyBoardCommand(board, { type: "update_label", id: "label-1", name: "x" }, ctx(board, alice));
  expect(member.ok).toBe(false);
  if (!member.ok) expect(member.code).toBe("forbidden");
  const badColor = applyBoardCommand(board, { type: "update_label", id: "label-1", color: "#000000" }, ctx(board, router));
  expect(badColor.ok).toBe(false);
  if (!badColor.ok) expect(badColor.code).toBe("invalid");
  const missing = applyBoardCommand(board, { type: "update_label", id: "label-9", name: "x" }, ctx(board, router));
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.code).toBe("not_found");
});

test("set_task_labels: assignee or privileged; non-owner forbidden; dedupes/orders/drops-unknown/caps", () => {
  let board = ok(createEmptyBoard("m"), { type: "create_label", name: "a", color: LABEL_PALETTE[0] }, router); // label-1
  board = ok(board, { type: "create_label", name: "b", color: LABEL_PALETTE[1] }, router); // label-2
  board = ok(board, { type: "create_task", title: "t", assignee: "alice" }, router); // #1 → alice
  const rev = () => board.tasks.find((t) => t.id === 1)!.revision;

  // non-owner member forbidden
  const denied = applyBoardCommand(board, { type: "set_task_labels", id: 1, expectedRevision: rev(), labelIds: ["label-1"] }, ctx(board, bob));
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.code).toBe("forbidden");

  // assignee may set; submitted order preserved among known, deduped, unknown dropped
  board = ok(board, { type: "set_task_labels", id: 1, expectedRevision: rev(), labelIds: ["label-2", "label-1", "label-2", "label-9"] }, alice);
  expect(board.tasks[0].labelIds).toEqual(["label-2", "label-1"]);

  // privileged (router) may also set; clearing works
  board = ok(board, { type: "set_task_labels", id: 1, expectedRevision: rev(), labelIds: [] }, router);
  expect(board.tasks[0].labelIds).toEqual([]);
});

test("delete_label cascades: removed from board AND stripped from every task that carried it", () => {
  let board = ok(createEmptyBoard("m"), { type: "create_label", name: "a", color: LABEL_PALETTE[0] }, router); // label-1
  board = ok(board, { type: "create_label", name: "b", color: LABEL_PALETTE[1] }, router); // label-2
  board = ok(board, { type: "create_task", title: "t1", assignee: "alice" }, router); // #1
  board = ok(board, { type: "create_task", title: "t2", assignee: "alice" }, router); // #2
  board = ok(board, { type: "set_task_labels", id: 1, expectedRevision: board.tasks.find((t) => t.id === 1)!.revision, labelIds: ["label-1", "label-2"] }, alice);
  board = ok(board, { type: "set_task_labels", id: 2, expectedRevision: board.tasks.find((t) => t.id === 2)!.revision, labelIds: ["label-1"] }, alice);
  const rev1 = board.tasks.find((t) => t.id === 1)!.revision;

  board = ok(board, { type: "delete_label", id: "label-1" }, router);
  expect(board.labels!.map((l) => l.id)).toEqual(["label-2"]);
  expect(board.tasks.find((t) => t.id === 1)!.labelIds).toEqual(["label-2"]); // label-1 stripped, order kept
  expect(board.tasks.find((t) => t.id === 2)!.labelIds).toEqual([]); // label-1 stripped
  expect(board.tasks.find((t) => t.id === 1)!.revision).toBe(rev1 + 1); // affected task bumped

  const missing = applyBoardCommand(board, { type: "delete_label", id: "label-1" }, ctx(board, router));
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.code).toBe("not_found");
});
