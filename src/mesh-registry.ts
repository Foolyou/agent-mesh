// src/mesh-registry.ts
// On-disk registry of running mesh-host daemons — one JSON file per mesh under
// ${runDir}, written by the daemon itself. It lets a freshly (re)started backend
// discover and reconnect to meshes that outlived it, and lets `mesh ps` / `mesh kill`
// enumerate and reap them. Records whose pid is dead are pruned on read.
import { readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface MeshHostRecord {
  name: string;
  pid: number;
  socketPath: string;
  proto: number;
  startedAt: string;
}

const recordPath = (runDir: string, name: string) => join(runDir, `${name}.json`);

export async function writeRecord(runDir: string, rec: MeshHostRecord): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(recordPath(runDir, rec.name), JSON.stringify(rec), "utf8");
}

export async function removeRecord(runDir: string, name: string): Promise<void> {
  await rm(recordPath(runDir, name), { force: true });
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

/** All records whose daemon is still alive; deletes (prunes) any whose pid is dead. */
export async function listLiveRecords(runDir: string): Promise<MeshHostRecord[]> {
  let files: string[];
  try {
    files = (await readdir(runDir)).filter((f) => f.endsWith(".json"));
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
