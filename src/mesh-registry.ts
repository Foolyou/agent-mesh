// src/mesh-registry.ts
// On-disk registry of running mesh-host daemons — one JSON file per mesh under
// ${runDir}, written by the daemon itself. It lets a freshly (re)started backend
// discover and reconnect to meshes that outlived it, and lets `mesh ps` / `mesh kill`
// enumerate and reap them. Records whose pid is dead are pruned on read.
import { readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface MeshHostRecord {
  /** Mesh name inside the storage root namespace. */
  name: string;
  pid: number;
  socketPath: string;
  proto: number;
  startedAt: string;
  /** Storage root that owns this host. Diagnostic metadata only; the runDir path is authoritative. */
  root?: string;
  /** Run directory that contains this record. Diagnostic metadata only. */
  runDir?: string;
  /** Executable path that launched the host. Diagnostic metadata, not part of the namespace. */
  executable?: string;
  /** Optional deploy/build id read from the executable's .build-id sidecar. */
  buildId?: string;
  /** Host cwd at launch, useful when diagnosing mixed worktree/binary incidents. */
  cwd?: string;
}

const recordPath = (runDir: string, name: string) => join(runDir, `${name}.json`);

export async function writeRecord(runDir: string, rec: MeshHostRecord): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(recordPath(runDir, rec.name), JSON.stringify(rec), "utf8");
}

export async function removeRecord(runDir: string, name: string): Promise<void> {
  await rm(recordPath(runDir, name), { force: true });
}

export interface ConditionalRemoveResult {
  removed: boolean;
  record?: MeshHostRecord;
}

/** Remove a host record only when it is missing or its recorded pid is no longer alive. */
export async function removeRecordIfDead(runDir: string, name: string): Promise<ConditionalRemoveResult> {
  const record = await readRecord(runDir, name);
  if (record && pidAlive(record.pid)) return { removed: false, record };
  await removeRecord(runDir, name);
  return { removed: true, record };
}

/** signal 0 never kills; ESRCH ⇒ the process is gone, EPERM ⇒ alive but not ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export async function readRecord(runDir: string, name: string): Promise<MeshHostRecord | undefined> {
  try {
    const rec = JSON.parse(await readFile(recordPath(runDir, name), "utf8")) as MeshHostRecord;
    return rec && typeof rec.pid === "number" && typeof rec.socketPath === "string" ? rec : undefined;
  } catch {
    return undefined;
  }
}

export interface ReapResult {
  /** hosts that had a live pid and are now confirmed dead */
  killed: number;
  /** records/sockets removed from the run dir */
  cleaned: number;
  /** names whose pid outlived even SIGKILL — their record is KEPT so a later reap retries */
  survived: string[];
}

async function waitAllGone(pids: number[], ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every((p) => !pidAlive(p))) return;
    await Bun.sleep(100);
  }
}

/**
 * Tear down EVERY mesh-host under runDir — the `--cold` sweep. It scans the data dir for
 * all historical host pidfiles (`<name>.json`) AND sockets (`<name>.sock`), not just the
 * currently-tracked ones, then escalates SIGTERM→SIGKILL and only forgets a host (deletes
 * its record + socket) once its pid is CONFIRMED dead. This closes the leak where a single
 * SIGTERM was sent and the record deleted immediately: a host that traps SIGTERM survived
 * but lost its record, becoming alive-but-invisible to every future reap. Orphaned `.sock`
 * files with no record are swept too. `.sessions.json` (resume state) is left untouched.
 */
export async function reapAllHosts(runDir: string, opts: { termWaitMs?: number; killWaitMs?: number } = {}): Promise<ReapResult> {
  let entries: string[];
  try {
    entries = await readdir(runDir);
  } catch {
    return { killed: 0, cleaned: 0, survived: [] };
  }
  const recordNames = entries.filter((f) => f.endsWith(".json") && !f.endsWith(".sessions.json")).map((f) => f.slice(0, -5));
  const sockNames = entries.filter((f) => f.endsWith(".sock")).map((f) => f.slice(0, -5));
  const names = [...new Set([...recordNames, ...sockNames])];

  interface Host { name: string; pid?: number; sockPath: string; }
  const hosts: Host[] = [];
  for (const name of names) {
    const rec = await readRecord(runDir, name);
    hosts.push({ name, pid: rec?.pid, sockPath: rec?.socketPath ?? join(runDir, `${name}.sock`) });
  }

  // Escalate in one batch: SIGTERM every live host, wait, then SIGKILL the survivors.
  const liveBefore = hosts.filter((h): h is Host & { pid: number } => h.pid !== undefined && pidAlive(h.pid));
  for (const h of liveBefore) try { process.kill(h.pid, "SIGTERM"); } catch { /* raced */ }
  await waitAllGone(liveBefore.map((h) => h.pid), opts.termWaitMs ?? 4000);
  const survivors = liveBefore.filter((h) => pidAlive(h.pid));
  for (const h of survivors) try { process.kill(h.pid, "SIGKILL"); } catch { /* raced */ }
  await waitAllGone(survivors.map((h) => h.pid), opts.killWaitMs ?? 2000);

  // Forget every host whose pid is now dead; keep (retry later) any that outlived SIGKILL.
  let killed = 0, cleaned = 0;
  const survived: string[] = [];
  for (const h of hosts) {
    if (h.pid !== undefined && pidAlive(h.pid)) { survived.push(h.name); continue; }
    if (liveBefore.some((l) => l.name === h.name)) killed++;
    await removeRecord(runDir, h.name);
    await rm(h.sockPath, { force: true }).catch(() => {});
    cleaned++;
  }
  return { killed, cleaned, survived };
}

/** All records whose daemon is still alive; deletes (prunes) any whose pid is dead. */
export async function listLiveRecords(runDir: string): Promise<MeshHostRecord[]> {
  let files: string[];
  try {
    files = (await readdir(runDir)).filter((f) => f.endsWith(".json") && !f.endsWith(".sessions.json"));
  } catch {
    return [];
  }
  const live: MeshHostRecord[] = [];
  for (const f of files) {
    const name = f.slice(0, -5);
    const rec = await readRecord(runDir, name);
    if (rec && pidAlive(rec.pid)) live.push(rec);
    else await removeRecord(runDir, name);
  }
  return live;
}
