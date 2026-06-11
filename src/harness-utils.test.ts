import { expect, test } from "bun:test";
import { effortOptionsForHarness, runtimeEffortConfig, supportsRuntimeEffort } from "./harness-utils";
import type { HarnessId } from "./acp/types";

test("declares effort options per harness for UI selectors", () => {
  expect(effortOptionsForHarness("codex")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(effortOptionsForHarness("claude")).toEqual(["minimal", "low", "medium", "high", "max"]);
  expect(effortOptionsForHarness("kimi")).toEqual(["low", "high"]);
  expect(effortOptionsForHarness("opencode")).toEqual([]);
});

test("declares runtime effort switching only for claude and kimi", () => {
  const runtime = (["codex", "claude", "kimi", "opencode"] as HarnessId[]).filter((h) => supportsRuntimeEffort(h));
  expect(runtime).toEqual(["claude", "kimi"]);
});

test("maps runtime effort config per harness", () => {
  expect(runtimeEffortConfig("claude", "minimal")).toEqual({ configId: "thought_level", value: "minimal" });
  expect(runtimeEffortConfig("claude", "high")).toEqual({ configId: "thought_level", value: "high" });
  expect(runtimeEffortConfig("claude", "max", "output_config.effort")).toEqual({ configId: "output_config.effort", value: "max" });
  expect(runtimeEffortConfig("kimi", "low")).toEqual({ configId: "thinking", value: "off" });
  expect(runtimeEffortConfig("kimi", "high")).toEqual({ configId: "thinking", value: "on" });
  expect(runtimeEffortConfig("codex", "xhigh")).toBeUndefined();
  expect(runtimeEffortConfig("opencode", undefined)).toBeUndefined();
});
