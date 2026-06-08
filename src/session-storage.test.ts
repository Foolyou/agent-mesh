import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLiveRecords, readRecord, writeRecord } from "./mesh-registry";
import { readSessionState, sessionStatePath, updateAgentSession, writeSessionState } from "./session-storage";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mesh-sessions-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("writes sessions atomically with private run directory and file permissions", async () => {
  await writeSessionState(dir, "dev", {
    meshExpectedAlive: true,
    agents: {
      Executor: {
        sessionId: "sess-1",
        cwd: "/tmp/worktree",
        harness: "codex",
        model: "gpt-5.3-codex",
        mode: "default",
        effort: "medium",
      },
    },
  });

  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(sessionStatePath(dir, "dev"))).mode & 0o777).toBe(0o600);
  expect(await readSessionState(dir, "dev")).toEqual({
    meshExpectedAlive: true,
    agents: {
      Executor: {
        sessionId: "sess-1",
        cwd: "/tmp/worktree",
        harness: "codex",
        model: "gpt-5.3-codex",
        mode: "default",
        effort: "medium",
      },
    },
  });
});

test("session metadata survives liveness registry dead-pid pruning", async () => {
  await updateAgentSession(dir, "dev", "Executor", {
    sessionId: "sess-1",
    cwd: "/tmp/worktree",
    harness: "claude",
  });
  await writeRecord(dir, { name: "dev", pid: 2147483646, socketPath: join(dir, "dev.sock"), proto: 2, startedAt: "T" });

  expect(await listLiveRecords(dir)).toEqual([]);
  expect(await readRecord(dir, "dev")).toBeUndefined();
  expect((await readSessionState(dir, "dev")).agents.Executor?.sessionId).toBe("sess-1");
});

test("sanitizes session state to identity fields only and ignores old malformed agent records", async () => {
  await writeFile(
    sessionStatePath(dir, "dev"),
    JSON.stringify({
      meshExpectedAlive: false,
      agents: {
        old: { sessionId: "missing-cwd" },
        Executor: {
          sessionId: "sess-1",
          cwd: "/tmp/worktree",
          harness: "opencode",
          model: "deepseek/deepseek-chat",
          mode: "build",
          effort: "high",
          transcript: "secret transcript",
          permissionToken: "token",
          toolOutput: "raw output",
        },
      },
    }),
    "utf8",
  );

  expect(await readSessionState(dir, "dev")).toEqual({
    meshExpectedAlive: false,
    agents: {
      Executor: {
        sessionId: "sess-1",
        cwd: "/tmp/worktree",
        harness: "opencode",
        model: "deepseek/deepseek-chat",
        mode: "build",
        effort: "high",
      },
    },
  });
});

test("first agent update defaults meshExpectedAlive to true", async () => {
  await updateAgentSession(dir, "dev", "Executor", {
    sessionId: "sess-1",
    cwd: "/tmp/worktree",
    harness: "kimi",
  });

  expect(await readSessionState(dir, "dev")).toEqual({
    meshExpectedAlive: true,
    agents: {
      Executor: { sessionId: "sess-1", cwd: "/tmp/worktree", harness: "kimi" },
    },
  });
});
