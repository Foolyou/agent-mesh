// src/mesh-registry.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRecord, readRecord, removeRecord, listLiveRecords, pidAlive, reapAllHosts } from "./mesh-registry";

let dir: string;
const spawned: ChildProcess[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "reg-")); spawned.length = 0; });
afterEach(async () => {
  for (const child of spawned) {
    if (child.pid) try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
  }
  await Promise.all(spawned.map((child) => waitChildExit(child, 1000)));
  await rm(dir, { recursive: true, force: true });
});

const rec = (name: string, pid: number) => ({ name, pid, socketPath: join(dir, `${name}.sock`), proto: 2, startedAt: "T" });

/**
 * Spawn a real, detached long-lived stub process. `stubborn` makes it trap+ignore SIGTERM
 * on platforms that support that signal, so only SIGKILL can stop it. Returns the stub's
 * own pid (read back from a pidfile).
 */
async function spawnStub(name: string, stubborn = false): Promise<number> {
  const pidfile = join(dir, `${name}.pid.tmp`);
  const trap = stubborn ? "process.on('SIGTERM',()=>{});" : "";
  const code = `require('fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); ${trap} setInterval(()=>{}, 1e9);`;
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 250; i++) {
    try {
      const s = (await readFile(pidfile, "utf8")).trim();
      if (s) {
        spawned.push(child);
        return Number(s);
      }
    } catch { /* not yet */ }
    await Bun.sleep(20);
  }
  if (child.pid) try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
  throw new Error(`stub ${name} never reported its pid`);
}

async function waitChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    Bun.sleep(timeoutMs).then(() => {}),
  ]);
}

const touchSock = (name: string) => writeFile(join(dir, `${name}.sock`), "");
const fast = { termWaitMs: 400, killWaitMs: 2000 };

test("write → read round-trips a record", async () => {
  await writeRecord(dir, rec("a", process.pid));
  const got = await readRecord(dir, "a");
  expect(got?.name).toBe("a");
  expect(got?.pid).toBe(process.pid);
});

test("pidAlive: true for self, false for a surely-dead pid", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2147483646)).toBe(false); // no such process
});

test("listLiveRecords keeps live, prunes + deletes dead", async () => {
  await writeRecord(dir, rec("live", process.pid));
  await writeRecord(dir, rec("dead", 2147483646));
  const live = await listLiveRecords(dir);
  expect(live.map((r) => r.name)).toEqual(["live"]);
  // the dead record's file was pruned
  expect(await readRecord(dir, "dead")).toBeUndefined();
});

test("removeRecord deletes the file", async () => {
  await writeRecord(dir, rec("x", process.pid));
  await removeRecord(dir, "x");
  expect(await readRecord(dir, "x")).toBeUndefined();
});

test("reapAllHosts: SIGTERM kills a live host, then deletes its record + socket", async () => {
  const pid = await spawnStub("a");
  await writeRecord(dir, rec("a", pid));
  await touchSock("a");

  const r = await reapAllHosts(dir, fast);

  expect(r.killed).toBe(1);
  expect(r.survived).toEqual([]);
  expect(pidAlive(pid)).toBe(false);
  expect(await readRecord(dir, "a")).toBeUndefined();
  expect(existsSync(join(dir, "a.sock"))).toBe(false);
});

test("reapAllHosts: escalates to SIGKILL for a host that ignores SIGTERM", async () => {
  const pid = await spawnStub("stubborn", /* stubborn */ true);
  await writeRecord(dir, rec("stubborn", pid));
  await touchSock("stubborn");

  const r = await reapAllHosts(dir, fast);

  expect(pidAlive(pid)).toBe(false); // SIGTERM ignored → SIGKILL finished it
  expect(r.killed).toBe(1);
  expect(r.survived).toEqual([]);
  expect(await readRecord(dir, "stubborn")).toBeUndefined();
  expect(existsSync(join(dir, "stubborn.sock"))).toBe(false);
});

test("reapAllHosts: cleans a record whose pid is already dead", async () => {
  await writeRecord(dir, rec("ghost", 2147483646)); // no such process
  await touchSock("ghost");

  const r = await reapAllHosts(dir, fast);

  expect(r.killed).toBe(0);
  expect(r.cleaned).toBe(1);
  expect(await readRecord(dir, "ghost")).toBeUndefined();
  expect(existsSync(join(dir, "ghost.sock"))).toBe(false);
});

test("reapAllHosts: sweeps an orphaned .sock that has no record", async () => {
  await touchSock("orphan"); // socket only, no .json record

  const r = await reapAllHosts(dir, fast);

  expect(existsSync(join(dir, "orphan.sock"))).toBe(false);
  expect(r.cleaned).toBe(1);
  expect(r.killed).toBe(0);
});

test("reapAllHosts: leaves .sessions.json (resume state) untouched", async () => {
  const pid = await spawnStub("keep");
  await writeRecord(dir, rec("keep", pid));
  await touchSock("keep");
  await writeFile(join(dir, "keep.sessions.json"), '{"meshExpectedAlive":true}');
  // a sessions file for a mesh with no live host/record must also survive
  await writeFile(join(dir, "dead-mesh.sessions.json"), '{"meshExpectedAlive":true}');

  await reapAllHosts(dir, fast);

  expect(pidAlive(pid)).toBe(false);
  expect(await readRecord(dir, "keep")).toBeUndefined();
  expect(existsSync(join(dir, "keep.sessions.json"))).toBe(true);
  expect(existsSync(join(dir, "dead-mesh.sessions.json"))).toBe(true);
});

test("reapAllHosts: a live host whose record was already lost still gets swept (no orphan leak)", async () => {
  // The incident: prior buggy reap removed the record but the process survived. Going
  // forward the .sock anchors discovery; with no pid we at least clear the stale socket.
  const pid = await spawnStub("recordless");
  await touchSock("recordless"); // socket present, NO .json record (simulating lost record)

  const r = await reapAllHosts(dir, fast);

  // socket is always swept so the run dir doesn't accumulate cruft
  expect(existsSync(join(dir, "recordless.sock"))).toBe(false);
  expect(r.cleaned).toBe(1);
  // (the process itself can't be found without a pid — that's why the real fix is to
  //  never delete a record before death; covered by the SIGKILL-escalation test above)
});

test("reapAllHosts: empty / missing run dir is a no-op", async () => {
  const r = await reapAllHosts(join(dir, "does-not-exist"), fast);
  expect(r).toEqual({ killed: 0, cleaned: 0, survived: [] });
});
