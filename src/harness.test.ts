import { expect, test } from "bun:test";
import { resolveHarness, spawnConfigFor } from "./harness";
import type { AgentConfig } from "./acp/types";

const A = (over: Partial<AgentConfig>): AgentConfig => ({ id: "a", harness: "codex", project: "p", role: "member", ...over });

test("codex applies model_reasoning_effort, defaulting to low", () => {
  expect(spawnConfigFor(A({ harness: "codex" })).args).toEqual(["-c", "model_reasoning_effort=low"]);
  expect(spawnConfigFor(A({ harness: "codex", effort: "high" })).args).toEqual(["-c", "model_reasoning_effort=high"]);
  expect(spawnConfigFor(A({ harness: "codex" })).env).toEqual({});
  expect(spawnConfigFor(A({ harness: "codex" })).command).toBe("codex-acp");
});

test("claude sets MAX_THINKING_TOKENS only when an effort is chosen", () => {
  expect(spawnConfigFor(A({ harness: "claude" })).env).toEqual({});
  expect(spawnConfigFor(A({ harness: "claude" })).args).toEqual([]);
  expect(spawnConfigFor(A({ harness: "claude", effort: "high" })).env).toEqual({ MAX_THINKING_TOKENS: "24000" });
  expect(spawnConfigFor(A({ harness: "claude", effort: "minimal" })).env).toEqual({ MAX_THINKING_TOKENS: "1024" });
});

test("opencode ignores effort (no mechanism)", () => {
  const c = spawnConfigFor(A({ harness: "opencode", effort: "high" }));
  expect(c.args).toEqual(["acp"]);
  expect(c.env).toEqual({});
});

test("resolves all three harnesses to a command", () => {
  expect(resolveHarness("codex").command).toBe("codex-acp");
  expect(resolveHarness("opencode").args).toEqual(["acp"]);
  expect(resolveHarness("claude").command).toBe("claude-agent-acp");
});

test("unknown harness throws", () => {
  expect(() => resolveHarness("nope" as any)).toThrow();
});
