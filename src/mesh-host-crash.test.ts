import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMeshCrashDump } from "./mesh-host";

test("writeMeshCrashDump appends error stacks (and string reasons) to the crash log", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-crash-"));
  const log = join(root, "x.crash.log");
  try {
    writeMeshCrashDump(log, "uncaughtException", new Error("boom"));
    writeMeshCrashDump(log, "unhandledRejection", "string reason");
    const txt = await readFile(log, "utf8");
    expect(txt).toContain("uncaughtException");
    expect(txt).toContain("boom");
    expect(txt).toContain("unhandledRejection");
    expect(txt).toContain("string reason");
    // two records appended
    expect(txt.match(/pid \d+/g)?.length).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeMeshCrashDump never throws even when the path is unwritable", () => {
  // A non-existent directory must not produce a throw that masks the original crash.
  expect(() => writeMeshCrashDump("/nonexistent-dir-xyz/deep/x.crash.log", "uncaughtException", new Error("x"))).not.toThrow();
});
