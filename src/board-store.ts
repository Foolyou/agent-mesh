// Durable per-mesh board persistence: `<root>/boards/<mesh>.json`.
//
// Mirrors the session-storage pattern: atomic tmp+rename writes (mode 0600), ENOENT reads
// default to an empty board, and a deleteMesh cleanup path. Adds an in-process per-path
// lock (the mailbox pattern) so concurrent mutations on one mesh serialize their
// read/modify/write even though the daemon is single-process — the ControlPlane holds the
// board in memory as the source of truth, but the lock keeps the on-disk mirror coherent.
import { mkdir, readFile, writeFile, rename, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BOARD_PRIORITIES,
  BOARD_STATUSES,
  createEmptyBoard,
  type BoardComment,
  type BoardPriority,
  type BoardState,
  type BoardStatus,
  type Epic,
  type Subtask,
  type Task,
} from "./board";

/** The boards directory under the agent-mesh data root (sibling of `meshes/`, `run/`). */
export function boardsDirFor(root: string): string {
  return join(root, "boards");
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Reject names that could escape the boards directory. Mirrors assertSafeArtifactName. */
export function assertSafeBoardName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("..") || !SAFE_NAME.test(name)) {
    throw new Error(`unsafe board name: ${JSON.stringify(name)}`);
  }
}

export function boardPath(boardsDir: string, mesh: string): string {
  assertSafeBoardName(mesh);
  return join(boardsDir, `${mesh}.json`);
}

// In-process write serialization, keyed by absolute file path. Identical shape to the
// mailbox lock: each caller chains onto the previous promise for the same path.
const boardLocks = new Map<string, Promise<unknown>>();

export async function withBoardLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = boardLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current, () => current);
  boardLocks.set(path, chained);
  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (boardLocks.get(path) === chained) boardLocks.delete(path);
  }
}

/** Read the persisted board, or a fresh empty board if none exists / the file is corrupt. */
export async function readBoard(boardsDir: string, mesh: string): Promise<BoardState> {
  const path = boardPath(boardsDir, mesh);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return createEmptyBoard(mesh);
    throw err;
  }
  try {
    return sanitizeBoard(mesh, JSON.parse(raw));
  } catch {
    // A corrupt/half-written file should not wedge the mesh; start fresh rather than throw.
    return createEmptyBoard(mesh);
  }
}

/** Atomically persist the board (tmp file + rename), serialized per path. */
export async function writeBoard(boardsDir: string, mesh: string, state: BoardState): Promise<void> {
  const path = boardPath(boardsDir, mesh);
  await withBoardLock(path, async () => {
    await mkdir(boardsDir, { recursive: true, mode: 0o700 });
    await chmod(boardsDir, 0o700).catch(() => {});
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...state, mesh }, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => {});
  });
}

/** Remove a mesh's board file (called from MeshManager.deleteMesh). No-op if absent. */
export async function deleteBoard(boardsDir: string | undefined, mesh: string): Promise<void> {
  if (!boardsDir) return;
  const path = boardPath(boardsDir, mesh);
  await withBoardLock(path, () => rm(path, { force: true }));
}

// ── defensive sanitization ──────────────────────────────────────────────────
// Hand-edited or version-skewed board files must never crash the daemon or the derived
// helpers (computeBoardWarnings, taskProgress). We rebuild every entity from scratch with
// validated fields, DROP entries we cannot address (bad/duplicate id), and normalize
// seq/revision so id allocation never collides with a retained item.

const EPOCH = "1970-01-01T00:00:00.000Z";

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}
function isoOr(v: unknown): string {
  return typeof v === "string" && v ? v : EPOCH;
}
function statusOr(v: unknown): BoardStatus {
  return typeof v === "string" && (BOARD_STATUSES as readonly string[]).includes(v) ? (v as BoardStatus) : "todo";
}
function priorityOr(v: unknown): BoardPriority {
  return typeof v === "string" && (BOARD_PRIORITIES as readonly string[]).includes(v) ? (v as BoardPriority) : "normal";
}
function intAtLeast(v: unknown, min: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min ? v : min;
}
function sanitizeComments(v: unknown): BoardComment[] {
  if (!Array.isArray(v)) return [];
  const out: BoardComment[] = [];
  for (const raw of v) {
    const o = asObject(raw);
    const text = o ? cleanStr(o.text, 4000) : undefined;
    if (!text) continue;
    out.push({ author: cleanStr(o!.author, 200) ?? "unknown", text, ts: isoOr(o!.ts) });
  }
  return out;
}
function sanitizeStrArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = cleanStr(item, max);
    if (s) out.push(s);
  }
  return [...new Set(out)];
}
function sanitizeDeps(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((d) => Number.isInteger(d) && (d as number) > 0) as number[])];
}

function sanitizeSubtask(raw: unknown, parentTaskId: number, seen: Set<string>): Subtask | null {
  const o = asObject(raw);
  if (!o) return null;
  const id = cleanStr(o.id, 200);
  // Locked id shape is "<taskId>.<n>" (n a positive int) and must belong to THIS parent.
  // Drop anything malformed rather than invent an identity mapping.
  if (!id || seen.has(id)) return null;
  const m = /^(\d+)\.(\d+)$/.exec(id);
  if (!m || Number(m[1]) !== parentTaskId || Number(m[2]) <= 0) return null;
  seen.add(id);
  return {
    id,
    title: cleanStr(o.title, 200) ?? "(untitled)",
    status: statusOr(o.status),
    assignee: cleanStr(o.assignee, 200),
    revision: intAtLeast(o.revision, 1),
    createdBy: cleanStr(o.createdBy, 200) ?? "unknown",
    createdAt: isoOr(o.createdAt),
    updatedAt: isoOr(o.updatedAt),
    comments: sanitizeComments(o.comments),
  };
}

function sanitizeTask(raw: unknown, seenIds: Set<number>): Task | null {
  const o = asObject(raw);
  if (!o) return null;
  const id = o.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || seenIds.has(id)) return null;
  seenIds.add(id);
  const seenSub = new Set<string>();
  const subtasks: Subtask[] = [];
  if (Array.isArray(o.subtasks)) {
    for (const s of o.subtasks) {
      const sub = sanitizeSubtask(s, id, seenSub);
      if (sub) subtasks.push(sub);
    }
  }
  const maxSubSeq = subtasks.reduce((m, s) => {
    const n = Number(s.id.split(".")[1]);
    return Number.isInteger(n) ? Math.max(m, n) : m;
  }, 0);
  const epicId = cleanStr(o.epicId, 200);
  return {
    id,
    epicId,
    title: cleanStr(o.title, 200) ?? "(untitled)",
    description: cleanStr(o.description, 4000),
    status: statusOr(o.status),
    assignee: cleanStr(o.assignee, 200),
    priority: priorityOr(o.priority),
    deps: sanitizeDeps(o.deps).filter((d) => d !== id),
    subtasks,
    subtaskSeq: Math.max(intAtLeast(o.subtaskSeq, 0), maxSubSeq),
    revision: intAtLeast(o.revision, 1),
    createdBy: cleanStr(o.createdBy, 200) ?? "unknown",
    createdAt: isoOr(o.createdAt),
    updatedAt: isoOr(o.updatedAt),
    comments: sanitizeComments(o.comments),
    mailEventIds: sanitizeStrArray(o.mailEventIds, 200),
  };
}

function sanitizeEpic(raw: unknown, seenIds: Set<string>): Epic | null {
  const o = asObject(raw);
  if (!o) return null;
  const id = cleanStr(o.id, 200);
  // Locked id shape is "epic-N" (N a positive int). Drop malformed ids and derive seq from
  // the id (it is authoritative) so the display label E{seq} can never drift from the id.
  if (!id || seenIds.has(id)) return null;
  const m = /^epic-(\d+)$/.exec(id);
  if (!m) return null;
  const seq = Number(m[1]);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  seenIds.add(id);
  return {
    id,
    seq,
    title: cleanStr(o.title, 200) ?? "(untitled)",
    description: cleanStr(o.description, 4000),
    status: statusOr(o.status),
    revision: intAtLeast(o.revision, 1),
    createdBy: cleanStr(o.createdBy, 200) ?? "unknown",
    createdAt: isoOr(o.createdAt),
    updatedAt: isoOr(o.updatedAt),
    comments: sanitizeComments(o.comments),
  };
}

/** Rebuild a well-formed BoardState from arbitrary parsed JSON. Top-level non-object falls
 *  back to an empty board; malformed entity entries are dropped; seq/revision are normalized
 *  so newly-allocated ids never collide with retained items. Never throws. */
function sanitizeBoard(mesh: string, parsed: unknown): BoardState {
  const obj = asObject(parsed);
  if (!obj) return createEmptyBoard(mesh);

  const epics: Epic[] = [];
  const seenEpicIds = new Set<string>();
  if (Array.isArray(obj.epics)) {
    for (const e of obj.epics) {
      const epic = sanitizeEpic(e, seenEpicIds);
      if (epic) epics.push(epic);
    }
  }
  const tasks: Task[] = [];
  const seenTaskIds = new Set<number>();
  if (Array.isArray(obj.tasks)) {
    for (const t of obj.tasks) {
      const task = sanitizeTask(t, seenTaskIds);
      if (task) tasks.push(task);
    }
  }

  const maxEpicSeq = epics.reduce((m, e) => Math.max(m, e.seq), 0);
  const maxTaskId = tasks.reduce((m, t) => Math.max(m, t.id), 0);
  return {
    mesh,
    revision: intAtLeast(obj.revision, 0),
    epicSeq: Math.max(intAtLeast(obj.epicSeq, 0), maxEpicSeq),
    taskSeq: Math.max(intAtLeast(obj.taskSeq, 0), maxTaskId),
    epics,
    tasks,
  };
}
