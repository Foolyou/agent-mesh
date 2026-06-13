import { expect, test } from "bun:test";
import { resolveHarness, spawnConfigFor } from "./harness";
import type { AgentConfig } from "./acp/types";

const A = (over: Partial<AgentConfig>): AgentConfig => ({ id: "a", harness: "codex", project: "p", role: "member", ...over });

test("codex applies model_reasoning_effort, defaulting to low", () => {
  expect(spawnConfigFor(A({ harness: "codex" })).args).toEqual(["-c", "model_reasoning_effort=low"]);
  expect(spawnConfigFor(A({ harness: "codex", effort: "high" })).args).toEqual(["-c", "model_reasoning_effort=high"]);
  expect(spawnConfigFor(A({ harness: "codex", effort: "xhigh" })).args).toEqual(["-c", "model_reasoning_effort=xhigh"]);
  expect(spawnConfigFor(A({ harness: "codex" })).env).toEqual({});
  expect(spawnConfigFor(A({ harness: "codex" })).command).toBe("codex-acp");
});

test("claude sets MAX_THINKING_TOKENS only when an effort is chosen", () => {
  expect(spawnConfigFor(A({ harness: "claude" })).env).toEqual({});
  expect(spawnConfigFor(A({ harness: "claude" })).args).toEqual([]);
  expect(spawnConfigFor(A({ harness: "claude", effort: "high" })).env).toEqual({ MAX_THINKING_TOKENS: "24000" });
  expect(spawnConfigFor(A({ harness: "claude", effort: "minimal" })).env).toEqual({ MAX_THINKING_TOKENS: "1024" });
});

test("claude adds no permission spawn flag (permission is a session mode)", () => {
  const c = spawnConfigFor(A({ harness: "claude", effort: "high" }));
  expect(c.args).toEqual([]);
  expect(c.env).toEqual({ MAX_THINKING_TOKENS: "24000" });
});

test("opencode permission=allow sets the spawn permission environment variable", () => {
  const c = spawnConfigFor(A({ harness: "opencode", opencodePermission: "allow" }));
  expect(c.args).toEqual(["acp"]);
  expect(c.env).toEqual({ OPENCODE_PERMISSION: '{"*":"allow"}' });
});

test("opencode permission=ask (or unset) injects no permission env", () => {
  expect(spawnConfigFor(A({ harness: "opencode", opencodePermission: "ask" })).env).toEqual({});
  expect(spawnConfigFor(A({ harness: "opencode" })).env).toEqual({});
});

test("opencode and kimi ignore spawn-time effort", () => {
  const c = spawnConfigFor(A({ harness: "opencode", effort: "high" }));
  expect(c.args).toEqual(["acp"]);
  expect(c.env).toEqual({});
  const k = spawnConfigFor(A({ harness: "kimi", effort: "high" }));
  expect(k.command).toBe("kimi");
  expect(k.args).toEqual(["acp"]);
  expect(k.env).toEqual({});
});

test("resolves all harnesses to a command", () => {
  expect(resolveHarness("codex").command).toBe("codex-acp");
  expect(resolveHarness("opencode").args).toEqual(["acp"]);
  expect(resolveHarness("claude").command).toBe("claude-agent-acp");
  expect(resolveHarness("kimi")).toEqual({ command: "kimi", args: ["acp"] });
});

test("unknown harness throws", () => {
  expect(() => resolveHarness("nope" as any)).toThrow();
});
