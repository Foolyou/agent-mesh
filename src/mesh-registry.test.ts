// src/mesh-registry.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRecord, readRecord, removeRecord, listLiveRecords, pidAlive } from "./mesh-registry";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "reg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const rec = (name: string, pid: number) => ({ name, pid, socketPath: join(dir, `${name}.sock`), proto: 2, startedAt: "T" });

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
