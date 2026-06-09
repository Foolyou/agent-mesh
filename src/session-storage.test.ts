import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLiveRecords, readRecord, writeRecord } from "./mesh-registry";
import { clearAgentSession, clearAllAgentSessions, readSessionState, sessionStatePath, updateAgentSession, writeSessionState } from "./session-storage";

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

test("clearAgentSession blanks only the target's sessionId, keeps other fields", async () => {
  await writeSessionState(dir, "m", {
    meshExpectedAlive: true,
    agents: {
      a: { sessionId: "sid-a", cwd: "/x", harness: "codex", mode: "build", model: "kimi-k2", effort: "high" },
      b: { sessionId: "sid-b", cwd: "/y", harness: "claude" },
    },
  });
  const state = await clearAgentSession(dir, "m", "a");
  expect(state.agents.a).toEqual({ sessionId: "", cwd: "/x", harness: "codex", mode: "build", model: "kimi-k2", effort: "high" });
  expect(state.agents.b.sessionId).toBe("sid-b");
  expect(state.meshExpectedAlive).toBe(true);
  expect((await readSessionState(dir, "m")).agents.a.sessionId).toBe("");
});

test("clearAgentSession is a no-op when the agent has no record", async () => {
  await writeSessionState(dir, "m", { meshExpectedAlive: true, agents: {} });
  const state = await clearAgentSession(dir, "m", "ghost");
  expect(state.agents.ghost).toBeUndefined();
});

test("clearAllAgentSessions blanks every sessionId, preserves meshExpectedAlive", async () => {
  await writeSessionState(dir, "m", {
    meshExpectedAlive: false,
    agents: {
      a: { sessionId: "sid-a", cwd: "/x", harness: "codex" },
      b: { sessionId: "sid-b", cwd: "/y", harness: "claude" },
    },
  });
  const state = await clearAllAgentSessions(dir, "m");
  expect(state.agents.a.sessionId).toBe("");
  expect(state.agents.b.sessionId).toBe("");
  expect(state.meshExpectedAlive).toBe(false);
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
