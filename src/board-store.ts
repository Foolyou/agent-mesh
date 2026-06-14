// Durable per-mesh board persistence: `<root>/boards/<mesh>.json`.
//
// Mirrors the session-storage pattern: atomic tmp+rename writes (mode 0600), ENOENT reads
// default to an empty board, and a deleteMesh cleanup path. Adds an in-process per-path
// lock (the mailbox pattern) so concurrent mutations on one mesh serialize their
// read/modify/write even though the daemon is single-process — the ControlPlane holds the
// board in memory as the source of truth, but the lock keeps the on-disk mirror coherent.
import { mkdir, readFile, writeFile, rename, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptyBoard, type BoardState } from "./board";

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

/** Coerce arbitrary parsed JSON into a well-formed BoardState, dropping anything malformed.
 *  Defensive against hand-edited / version-skewed files; never throws. */
function sanitizeBoard(mesh: string, parsed: unknown): BoardState {
  const base = createEmptyBoard(mesh);
  if (typeof parsed !== "object" || parsed === null) return base;
  const obj = parsed as Record<string, unknown>;
  const epics = Array.isArray(obj.epics) ? (obj.epics as BoardState["epics"]) : [];
  const tasks = Array.isArray(obj.tasks) ? (obj.tasks as BoardState["tasks"]) : [];
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    mesh,
    revision: num(obj.revision, 0),
    epicSeq: num(obj.epicSeq, epics.reduce((m, e) => Math.max(m, e?.seq ?? 0), 0)),
    taskSeq: num(obj.taskSeq, tasks.reduce((m, t) => Math.max(m, t?.id ?? 0), 0)),
    epics,
    tasks,
  };
}
