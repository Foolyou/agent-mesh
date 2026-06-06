import { expect, test } from "bun:test";
import { resolveHarness } from "./harness";

test("resolves all three harnesses to a command", () => {
  expect(resolveHarness("codex").command).toBe("codex-acp");
  expect(resolveHarness("opencode").args).toEqual(["acp"]);
  expect(resolveHarness("claude").command).toBe("claude-agent-acp");
});

test("unknown harness throws", () => {
  expect(() => resolveHarness("nope" as any)).toThrow();
});
