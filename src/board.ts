// Per-mesh collaboration board: a pure, deterministic data model + reducer.
//
// Hierarchy: Epic → Task → Subtask. Epics are router/human-only; tasks and subtasks
// can be created by any agent. The reducer is the single source of mutation logic — it
// owns permissions, optimistic-concurrency (CAS) checks, id allocation, and timestamps.
// It performs NO IO and NO clock/random access: the caller passes `now` (ISO string) and
// the acting identity in `BoardContext`, so every transition is reproducible in tests and
// safe to run inside the daemon's single-threaded event loop.
//
// Dependencies are advisory: the reducer stores them and computeBoardWarnings() surfaces
// cycles / blocked-by-incomplete as warnings, but nothing is ever auto-transitioned or
// hard-gated (product decision: "仅 warnings，不硬门禁/不自动流转").

export type BoardStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";
export type BoardPriority = "low" | "normal" | "high" | "urgent";

/** Statuses a non-privileged agent may move an item INTO. Agents can progress work up to
 *  review, but only a router/human/operator may mark something done or cancelled. */
export const AGENT_SETTABLE_STATUSES: readonly BoardStatus[] = ["todo", "in_progress", "in_review"];
export const BOARD_STATUSES: readonly BoardStatus[] = ["todo", "in_progress", "in_review", "done", "cancelled"];
export const BOARD_PRIORITIES: readonly BoardPriority[] = ["low", "normal", "high", "urgent"];

export type EpicId = string; // "epic-N"

export interface BoardComment {
  author: string; // agent id, or "operator" (human), or "system"
  text: string;
  ts: string;
}

export interface Subtask {
  id: string; // "<taskId>.<n>", e.g. "5.1"
  title: string;
  status: BoardStatus;
  assignee?: string;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  comments: BoardComment[];
}

export interface Task {
  id: number; // per-mesh number, displayed as "#N"
  epicId?: EpicId;
  title: string;
  description?: string;
  status: BoardStatus;
  assignee?: string;
  priority: BoardPriority;
  deps: number[]; // task ids this task depends on (advisory DAG)
  subtasks: Subtask[];
  subtaskSeq: number;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  comments: BoardComment[];
  mailEventIds: string[]; // mail events linked to this task (bidirectional ref)
}

export interface Epic {
  id: EpicId; // "epic-N"
  seq: number; // N, displayed as "E{N}"
  title: string;
  description?: string;
  status: BoardStatus;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  comments: BoardComment[];
}

export interface BoardState {
  mesh: string;
  /** Bumped on every successful mutation. The board-level CAS token. */
  revision: number;
  epicSeq: number;
  taskSeq: number;
  epics: Epic[];
  tasks: Task[];
}

/** The full board payload carried by the `board_snapshot` event and `t:"board"` WS message.
 *  Phase 1 ships the whole board on every change (no deltas), so the document IS the state. */
export type BoardDocument = BoardState;

export type BoardActor =
  | { kind: "human" } // web operator: full rights
  | { kind: "system" } // internal (mail linking, migrations): full rights
  | { kind: "router"; agentId: string } // router agent: full rights
  | { kind: "agent"; agentId: string }; // member agent: restricted

export interface BoardContext {
  actor: BoardActor;
  now: string; // ISO timestamp, supplied by the caller for determinism
  /** Board-level optimistic-concurrency token; must equal state.revision. Required for
   *  EVERY mutation (creates included) so a stale client can never apply onto a board it
   *  has not seen. Enforced at the top of applyBoardCommand before any mutation. */
  expectedBoardRevision: number;
}

export type BoardTargetRef =
  | { kind: "epic"; id: EpicId }
  | { kind: "task"; id: number }
  | { kind: "subtask"; taskId: number; subtaskId: string };

export type BoardCommand =
  | { type: "create_epic"; title: string; description?: string }
  | { type: "update_epic"; id: EpicId; expectedRevision: number; title?: string; description?: string; status?: BoardStatus }
  | { type: "delete_epic"; id: EpicId; expectedRevision: number }
  | { type: "create_task"; title: string; epicId?: EpicId; description?: string; priority?: BoardPriority; deps?: number[]; assignee?: string }
  | { type: "update_task"; id: number; expectedRevision: number; title?: string; description?: string; epicId?: EpicId | null }
  | { type: "set_task_status"; id: number; expectedRevision: number; status: BoardStatus }
  | { type: "assign_task"; id: number; expectedRevision: number; assignee?: string }
  | { type: "set_task_priority"; id: number; expectedRevision: number; priority: BoardPriority }
  | { type: "set_task_deps"; id: number; expectedRevision: number; deps: number[] }
  | { type: "create_subtask"; taskId: number; expectedRevision: number; title: string; assignee?: string }
  | { type: "update_subtask"; taskId: number; subtaskId: string; expectedRevision: number; title?: string }
  | { type: "set_subtask_status"; taskId: number; subtaskId: string; expectedRevision: number; status: BoardStatus }
  | { type: "add_comment"; target: BoardTargetRef; expectedRevision: number; text: string }
  | { type: "link_mail"; taskId: number; expectedRevision: number; mailEventId: string };

export type BoardErrorCode = "not_found" | "conflict" | "forbidden" | "invalid";

export type BoardCommandResult =
  | { ok: true; state: BoardState; change: BoardChange }
  | { ok: false; code: BoardErrorCode; error: string };

/** What a successful command touched. INTERNAL diagnostic/logging only — Phase 1 emits a
 *  single full-board snapshot event (board_snapshot), NEVER a partial delta derived from
 *  this. A command can mutate more than one entity (e.g. delete_epic orphans many tasks),
 *  so do not reconstruct external updates from BoardChange. */
export interface BoardChange {
  entity: "epic" | "task" | "subtask";
  epicId?: EpicId;
  taskId?: number;
  subtaskId?: string;
  deleted?: boolean;
}

export function createEmptyBoard(mesh: string): BoardState {
  return { mesh, revision: 0, epicSeq: 0, taskSeq: 0, epics: [], tasks: [] };
}

export function epicDisplayId(epic: Pick<Epic, "seq">): string {
  return `E${epic.seq}`;
}
export function taskDisplayId(id: number): string {
  return `#${id}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isPrivileged(actor: BoardActor): boolean {
  return actor.kind === "human" || actor.kind === "system" || actor.kind === "router";
}

function actorLabel(actor: BoardActor): string {
  if (actor.kind === "human") return "operator";
  if (actor.kind === "system") return "system";
  return actor.agentId;
}

function ok(state: BoardState, change: BoardChange): BoardCommandResult {
  return { ok: true, state, change };
}
function err(code: BoardErrorCode, error: string): BoardCommandResult {
  return { ok: false, code, error };
}

function cleanText(value: unknown, max = 4000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** A non-privileged agent may move an item it owns (assignee, or unassigned creator) only
 *  up to in_review — never to a terminal status. Privileged actors may set any status. */
function canAgentSetStatus(actor: BoardActor, ownerOk: boolean, status: BoardStatus): string | null {
  if (isPrivileged(actor)) return null;
  if (!ownerOk) return "only the assignee (or a router/operator) may change this item's status";
  if (!AGENT_SETTABLE_STATUSES.includes(status)) {
    return `agents may move work no further than "in_review"; "${status}" is router/operator-only`;
  }
  return null;
}

function ownsItem(actor: BoardActor, item: { assignee?: string; createdBy: string }): boolean {
  if (actor.kind !== "agent" && actor.kind !== "router") return isPrivileged(actor);
  const id = actor.agentId;
  if (item.assignee) return item.assignee === id;
  return item.createdBy === id; // unassigned: the creator owns it
}

// ── reducer ─────────────────────────────────────────────────────────────────

export function applyBoardCommand(state: BoardState, cmd: BoardCommand, ctx: BoardContext): BoardCommandResult {
  const { actor, now } = ctx;
  const author = actorLabel(actor);

  // Board-level CAS gates EVERY mutation (creates included): a stale or malformed token is
  // rejected before anything is touched.
  if (!Number.isInteger(ctx.expectedBoardRevision)) return err("invalid", "expectedBoardRevision must be an integer");
  if (ctx.expectedBoardRevision !== state.revision) {
    return err("conflict", `board revision conflict: expected ${ctx.expectedBoardRevision}, found ${state.revision} (reload and retry)`);
  }

  switch (cmd.type) {
    case "create_epic": {
      if (!isPrivileged(actor)) return err("forbidden", "only a router or operator may create epics");
      const title = cleanText(cmd.title, 200);
      if (!title) return err("invalid", "epic title is required");
      const seq = state.epicSeq + 1;
      const epic: Epic = {
        id: `epic-${seq}`,
        seq,
        title,
        description: cleanText(cmd.description),
        status: "todo",
        revision: 1,
        createdBy: author,
        createdAt: now,
        updatedAt: now,
        comments: [],
      };
      const next = { ...state, revision: state.revision + 1, epicSeq: seq, epics: [...state.epics, epic] };
      return ok(next, { entity: "epic", epicId: epic.id });
    }

    case "update_epic": {
      if (!isPrivileged(actor)) return err("forbidden", "only a router or operator may edit epics");
      const epic = state.epics.find((e) => e.id === cmd.id);
      if (!epic) return err("not_found", `no epic "${cmd.id}"`);
      const conflict = casCheck(epic.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      if (cmd.status && !BOARD_STATUSES.includes(cmd.status)) return err("invalid", `invalid status "${cmd.status}"`);
      const title = cmd.title === undefined ? epic.title : cleanText(cmd.title, 200);
      if (!title) return err("invalid", "epic title cannot be empty");
      const updated: Epic = {
        ...epic,
        title,
        description: cmd.description === undefined ? epic.description : cleanText(cmd.description),
        status: cmd.status ?? epic.status,
        revision: epic.revision + 1,
        updatedAt: now,
      };
      return ok(replaceEpic(state, updated), { entity: "epic", epicId: epic.id });
    }

    case "delete_epic": {
      if (!isPrivileged(actor)) return err("forbidden", "only a router or operator may delete epics");
      const epic = state.epics.find((e) => e.id === cmd.id);
      if (!epic) return err("not_found", `no epic "${cmd.id}"`);
      const conflict = casCheck(epic.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      // Orphan (don't cascade-delete) the epic's tasks: clear their epicId so work is never
      // silently lost when an epic is removed.
      const tasks = state.tasks.map((t) => (t.epicId === epic.id ? { ...t, epicId: undefined, revision: t.revision + 1, updatedAt: now } : t));
      const next = { ...state, revision: state.revision + 1, epics: state.epics.filter((e) => e.id !== epic.id), tasks };
      return ok(next, { entity: "epic", epicId: epic.id, deleted: true });
    }

    case "create_task": {
      const title = cleanText(cmd.title, 200);
      if (!title) return err("invalid", "task title is required");
      if (cmd.priority && !BOARD_PRIORITIES.includes(cmd.priority)) return err("invalid", `invalid priority "${cmd.priority}"`);
      // Epic membership, assignment, priority>normal, and deps are all router/human-only —
      // reject (do not silently normalize) when a non-privileged agent supplies them.
      if (!isPrivileged(actor)) {
        if (cmd.epicId) return err("forbidden", "only a router or operator may file a task under an epic");
        if (cmd.assignee || (cmd.deps && cmd.deps.length)) return err("forbidden", "only a router or operator may assign or set dependencies");
        if (cmd.priority && cmd.priority !== "normal") return err("forbidden", `only a router or operator may set "${cmd.priority}" priority`);
      }
      if (cmd.epicId && !state.epics.some((e) => e.id === cmd.epicId)) return err("not_found", `no epic "${cmd.epicId}"`);
      const deps = normalizeDeps(cmd.deps);
      const missing = deps.find((d) => !state.tasks.some((t) => t.id === d));
      if (missing !== undefined) return err("not_found", `dependency task #${missing} does not exist`);
      const id = state.taskSeq + 1;
      const task: Task = {
        id,
        epicId: cmd.epicId,
        title,
        description: cleanText(cmd.description),
        status: "todo",
        assignee: isPrivileged(actor) ? cmd.assignee : undefined,
        priority: cmd.priority ?? "normal",
        deps: deps.filter((d) => d !== id),
        subtasks: [],
        subtaskSeq: 0,
        revision: 1,
        createdBy: author,
        createdAt: now,
        updatedAt: now,
        comments: [],
        mailEventIds: [],
      };
      const next = { ...state, revision: state.revision + 1, taskSeq: id, tasks: [...state.tasks, task] };
      return ok(next, { entity: "task", taskId: id });
    }

    case "update_task": {
      const task = state.tasks.find((t) => t.id === cmd.id);
      if (!task) return err("not_found", `no task #${cmd.id}`);
      if (!isPrivileged(actor) && !ownsItem(actor, task)) return err("forbidden", "only the owner, a router, or operator may edit this task");
      // Re-parenting (changing epic membership) is router/human-only, like epic CRUD.
      if (cmd.epicId !== undefined && !isPrivileged(actor)) return err("forbidden", "only a router or operator may change a task's epic");
      const conflict = casCheck(task.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      let epicId = task.epicId;
      if (cmd.epicId !== undefined) {
        if (cmd.epicId === null) epicId = undefined;
        else if (!state.epics.some((e) => e.id === cmd.epicId)) return err("not_found", `no epic "${cmd.epicId}"`);
        else epicId = cmd.epicId;
      }
      const title = cmd.title === undefined ? task.title : cleanText(cmd.title, 200);
      if (!title) return err("invalid", "task title cannot be empty");
      const updated: Task = {
        ...task,
        title,
        description: cmd.description === undefined ? task.description : cleanText(cmd.description),
        epicId,
        revision: task.revision + 1,
        updatedAt: now,
      };
      return ok(replaceTask(state, updated), { entity: "task", taskId: task.id });
    }

    case "set_task_status": {
      const task = state.tasks.find((t) => t.id === cmd.id);
      if (!task) return err("not_found", `no task #${cmd.id}`);
      if (!BOARD_STATUSES.includes(cmd.status)) return err("invalid", `invalid status "${cmd.status}"`);
      const permErr = canAgentSetStatus(actor, ownsItem(actor, task), cmd.status);
      if (permErr) return err("forbidden", permErr);
      const conflict = casCheck(task.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      const updated: Task = { ...task, status: cmd.status, revision: task.revision + 1, updatedAt: now };
      return ok(replaceTask(state, updated), { entity: "task", taskId: task.id });
    }

    case "assign_task": {
      if (!isPrivileged(actor)) return err("forbidden", "only a router or operator may assign tasks");
      const task = state.tasks.find((t) => t.id === cmd.id);
      if (!task) return err("not_found", `no task #${cmd.id}`);
      const conflict = casCheck(task.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      const assignee = cleanText(cmd.assignee, 200);
      const updated: Task = { ...task, assignee, revision: task.revision + 1, updatedAt: now };
      return ok(replaceTask(state, updated), { entity: "task", taskId: task.id });
    }

    case "set_task_priority": {
      if (!isPrivileged(actor)) return err("forbidden", "only a router or operator may set priority");
      if (!BOARD_PRIORITIES.includes(cmd.priority)) return err("invalid", `invalid priority "${cmd.priority}"`);
      const task = state.tasks.find((t) => t.id === cmd.id);
      if (!task) return err("not_found", `no task #${cmd.id}`);
      const conflict = casCheck(task.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      const updated: Task = { ...task, priority: cmd.priority, revision: task.revision + 1, updatedAt: now };
      return ok(replaceTask(state, updated), { entity: "task", taskId: task.id });
    }

    case "set_task_deps": {
      if (!isPrivileged(actor)) return err("forbidden", "only a router or operator may set dependencies");
      const task = state.tasks.find((t) => t.id === cmd.id);
      if (!task) return err("not_found", `no task #${cmd.id}`);
      const conflict = casCheck(task.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      const deps = normalizeDeps(cmd.deps).filter((d) => d !== task.id);
      const missing = deps.find((d) => !state.tasks.some((t) => t.id === d));
      if (missing !== undefined) return err("not_found", `dependency task #${missing} does not exist`);
      // Cycles are allowed but surfaced by computeBoardWarnings (advisory, never hard-gated).
      const updated: Task = { ...task, deps, revision: task.revision + 1, updatedAt: now };
      return ok(replaceTask(state, updated), { entity: "task", taskId: task.id });
    }

    case "create_subtask": {
      const task = state.tasks.find((t) => t.id === cmd.taskId);
      if (!task) return err("not_found", `no task #${cmd.taskId}`);
      const title = cleanText(cmd.title, 200);
      if (!title) return err("invalid", "subtask title is required");
      if (!isPrivileged(actor) && cmd.assignee) return err("forbidden", "only a router or operator may assign");
      // Creating a subtask appends to and bumps the parent task, so it needs parent CAS.
      const conflict = casCheck(task.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      const subSeq = task.subtaskSeq + 1;
      const subtask: Subtask = {
        id: `${task.id}.${subSeq}`,
        title,
        status: "todo",
        assignee: isPrivileged(actor) ? cleanText(cmd.assignee, 200) : undefined,
        revision: 1,
        createdBy: author,
        createdAt: now,
        updatedAt: now,
        comments: [],
      };
      const updated: Task = { ...task, subtaskSeq: subSeq, subtasks: [...task.subtasks, subtask], revision: task.revision + 1, updatedAt: now };
      return ok(replaceTask(state, updated), { entity: "subtask", taskId: task.id, subtaskId: subtask.id });
    }

    case "update_subtask": {
      const task = state.tasks.find((t) => t.id === cmd.taskId);
      if (!task) return err("not_found", `no task #${cmd.taskId}`);
      const subtask = task.subtasks.find((s) => s.id === cmd.subtaskId);
      if (!subtask) return err("not_found", `no subtask "${cmd.subtaskId}"`);
      if (!isPrivileged(actor) && !ownsItem(actor, subtask)) return err("forbidden", "only the owner, a router, or operator may edit this subtask");
      const conflict = casCheck(subtask.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      const title = cmd.title === undefined ? subtask.title : cleanText(cmd.title, 200);
      if (!title) return err("invalid", "subtask title cannot be empty");
      const updatedSub: Subtask = { ...subtask, title, revision: subtask.revision + 1, updatedAt: now };
      return ok(replaceSubtask(state, task, updatedSub), { entity: "subtask", taskId: task.id, subtaskId: subtask.id });
    }

    case "set_subtask_status": {
      const task = state.tasks.find((t) => t.id === cmd.taskId);
      if (!task) return err("not_found", `no task #${cmd.taskId}`);
      const subtask = task.subtasks.find((s) => s.id === cmd.subtaskId);
      if (!subtask) return err("not_found", `no subtask "${cmd.subtaskId}"`);
      if (!BOARD_STATUSES.includes(cmd.status)) return err("invalid", `invalid status "${cmd.status}"`);
      const permErr = canAgentSetStatus(actor, ownsItem(actor, subtask), cmd.status);
      if (permErr) return err("forbidden", permErr);
      const conflict = casCheck(subtask.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      const updatedSub: Subtask = { ...subtask, status: cmd.status, revision: subtask.revision + 1, updatedAt: now };
      return ok(replaceSubtask(state, task, updatedSub), { entity: "subtask", taskId: task.id, subtaskId: subtask.id });
    }

    case "add_comment": {
      const text = cleanText(cmd.text);
      if (!text) return err("invalid", "comment text is required");
      const comment: BoardComment = { author, text, ts: now };
      const ref = cmd.target;
      // A comment still mutates the target entity, so it needs entity CAS too.
      if (ref.kind === "epic") {
        const epic = state.epics.find((e) => e.id === ref.id);
        if (!epic) return err("not_found", `no epic "${ref.id}"`);
        const conflict = casCheck(epic.revision, cmd.expectedRevision);
        if (conflict) return conflict;
        const updated: Epic = { ...epic, comments: [...epic.comments, comment], revision: epic.revision + 1, updatedAt: now };
        return ok(replaceEpic(state, updated), { entity: "epic", epicId: epic.id });
      }
      if (ref.kind === "task") {
        const task = state.tasks.find((t) => t.id === ref.id);
        if (!task) return err("not_found", `no task #${ref.id}`);
        const conflict = casCheck(task.revision, cmd.expectedRevision);
        if (conflict) return conflict;
        const updated: Task = { ...task, comments: [...task.comments, comment], revision: task.revision + 1, updatedAt: now };
        return ok(replaceTask(state, updated), { entity: "task", taskId: task.id });
      }
      const task = state.tasks.find((t) => t.id === ref.taskId);
      if (!task) return err("not_found", `no task #${ref.taskId}`);
      const subtask = task.subtasks.find((s) => s.id === ref.subtaskId);
      if (!subtask) return err("not_found", `no subtask "${ref.subtaskId}"`);
      const conflict = casCheck(subtask.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      const updatedSub: Subtask = { ...subtask, comments: [...subtask.comments, comment], revision: subtask.revision + 1, updatedAt: now };
      return ok(replaceSubtask(state, task, updatedSub), { entity: "subtask", taskId: task.id, subtaskId: subtask.id });
    }

    case "link_mail": {
      // Internal-only: the ControlPlane send_mail path applies this; agents/operators
      // never call it directly.
      if (actor.kind !== "system") return err("forbidden", "link_mail is an internal operation");
      const task = state.tasks.find((t) => t.id === cmd.taskId);
      if (!task) return err("not_found", `no task #${cmd.taskId}`);
      if (!cmd.mailEventId) return err("invalid", "mailEventId is required");
      const conflict = casCheck(task.revision, cmd.expectedRevision);
      if (conflict) return conflict;
      if (task.mailEventIds.includes(cmd.mailEventId)) return ok(state, { entity: "task", taskId: task.id }); // idempotent
      const updated: Task = { ...task, mailEventIds: [...task.mailEventIds, cmd.mailEventId], revision: task.revision + 1, updatedAt: now };
      return ok(replaceTask(state, updated), { entity: "task", taskId: task.id });
    }

    default:
      // Unknown command.type at RUNTIME (malformed/forward-compat JSON over the wire). The
      // static union is exhaustive, so `cmd` is `never` here — return a structured invalid
      // result rather than falling off the end and returning undefined.
      return err("invalid", `unknown board command "${(cmd as { type?: unknown }).type ?? "?"}"`);
  }
}

/** Entity-level CAS. Every mutation of an existing entity must carry the entity's last-seen
 *  revision; a missing/non-integer token is invalid, a mismatched one is a conflict. */
function casCheck(actual: number, expected: number): BoardCommandResult | null {
  if (!Number.isInteger(expected)) return err("invalid", "expectedRevision must be an integer");
  if (actual !== expected) {
    return err("conflict", `revision conflict: expected ${expected}, found ${actual} (reload and retry)`);
  }
  return null;
}

function normalizeDeps(deps: number[] | undefined): number[] {
  if (!Array.isArray(deps)) return [];
  return [...new Set(deps.filter((d) => Number.isInteger(d) && d > 0))];
}

function replaceEpic(state: BoardState, epic: Epic): BoardState {
  return { ...state, revision: state.revision + 1, epics: state.epics.map((e) => (e.id === epic.id ? epic : e)) };
}
function replaceTask(state: BoardState, task: Task): BoardState {
  return { ...state, revision: state.revision + 1, tasks: state.tasks.map((t) => (t.id === task.id ? task : t)) };
}
function replaceSubtask(state: BoardState, task: Task, subtask: Subtask): BoardState {
  const updated: Task = { ...task, subtasks: task.subtasks.map((s) => (s.id === subtask.id ? subtask : s)), updatedAt: subtask.updatedAt };
  return replaceTask(state, updated);
}

// ── derived views (pure) ───────────────────────────────────────────────────────

export interface Progress {
  done: number;
  total: number;
  /** 0..1; a task with no subtasks reports progress from its own status. */
  ratio: number;
}

function statusIsDone(status: BoardStatus): boolean {
  return status === "done";
}

/** Parent task progress derived from subtasks. A task with no subtasks is 1 when done. */
export function taskProgress(task: Task): Progress {
  if (task.subtasks.length === 0) {
    const done = statusIsDone(task.status) ? 1 : 0;
    return { done, total: 1, ratio: done };
  }
  const done = task.subtasks.filter((s) => statusIsDone(s.status)).length;
  const total = task.subtasks.length;
  return { done, total, ratio: total === 0 ? 0 : done / total };
}

/** Epic progress derived from its (non-cancelled) tasks. */
export function epicProgress(state: BoardState, epicId: EpicId): Progress {
  const tasks = state.tasks.filter((t) => t.epicId === epicId && t.status !== "cancelled");
  if (tasks.length === 0) return { done: 0, total: 0, ratio: 0 };
  const done = tasks.filter((t) => statusIsDone(t.status)).length;
  return { done, total: tasks.length, ratio: done / tasks.length };
}

export type BoardWarning =
  | { kind: "dependency_cycle"; taskIds: number[]; message: string }
  | { kind: "missing_dependency"; taskId: number; dependsOn: number; message: string }
  | { kind: "blocked_by_incomplete"; taskId: number; dependsOn: number; message: string };

/** Advisory warnings only — never used to gate transitions or auto-flow status. Reports
 *  dependency cycles, dangling dep references, and tasks progressing while a dependency is
 *  not yet done. */
export function computeBoardWarnings(state: BoardState): BoardWarning[] {
  const warnings: BoardWarning[] = [];
  const byId = new Map(state.tasks.map((t) => [t.id, t]));

  // Dangling + blocked-by-incomplete.
  for (const task of state.tasks) {
    for (const dep of task.deps) {
      const depTask = byId.get(dep);
      if (!depTask) {
        warnings.push({ kind: "missing_dependency", taskId: task.id, dependsOn: dep, message: `#${task.id} depends on #${dep}, which no longer exists` });
        continue;
      }
      const taskActive = task.status === "in_progress" || task.status === "in_review" || task.status === "done";
      if (taskActive && depTask.status !== "done" && depTask.status !== "cancelled") {
        warnings.push({ kind: "blocked_by_incomplete", taskId: task.id, dependsOn: dep, message: `#${task.id} is ${task.status} but #${dep} is not done` });
      }
    }
  }

  // Cycle detection over the dependency graph (DFS with coloring).
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<number, number>();
  const reported = new Set<string>();
  const visit = (id: number, stack: number[]): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of byId.get(id)?.deps ?? []) {
      if (!byId.has(dep)) continue;
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const start = stack.indexOf(dep);
        const cycle = stack.slice(start);
        const key = [...cycle].sort((a, b) => a - b).join(",");
        if (!reported.has(key)) {
          reported.add(key);
          warnings.push({ kind: "dependency_cycle", taskIds: cycle, message: `dependency cycle: ${cycle.map((t) => `#${t}`).join(" → ")} → #${cycle[0]}` });
        }
      } else if (c === WHITE) {
        visit(dep, stack);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const task of state.tasks) {
    if ((color.get(task.id) ?? WHITE) === WHITE) visit(task.id, []);
  }

  return warnings;
}
