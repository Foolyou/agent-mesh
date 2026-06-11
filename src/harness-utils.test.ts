import { expect, test } from "bun:test";
import { runtimeEffortConfig } from "./harness-utils";

test("runtime effort config maps only dynamically supported harnesses", () => {
  expect(runtimeEffortConfig("claude", "minimal")).toEqual({ configId: "thought_level", value: "minimal" });
  expect(runtimeEffortConfig("claude", "high")).toEqual({ configId: "thought_level", value: "high" });
  expect(runtimeEffortConfig("kimi", "minimal")).toEqual({ configId: "thinking", value: "off" });
  expect(runtimeEffortConfig("kimi", "low")).toEqual({ configId: "thinking", value: "off" });
  expect(runtimeEffortConfig("kimi", "medium")).toEqual({ configId: "thinking", value: "on" });
  expect(runtimeEffortConfig("kimi", "high")).toEqual({ configId: "thinking", value: "on" });
  expect(runtimeEffortConfig("codex", "high")).toBeUndefined();
  expect(runtimeEffortConfig("opencode", "high")).toBeUndefined();
  expect(runtimeEffortConfig("claude", undefined)).toBeUndefined();
});
