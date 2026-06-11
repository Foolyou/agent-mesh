import { expect, test } from "bun:test";
import { effortOptionsForHarness, runtimeEffortConfig, runtimeEffortOptionsFromSession, supportsRuntimeEffort, supportedEffortsForConfig } from "./harness-utils";
import type { HarnessId } from "./acp/types";

test("declares effort options per harness for UI selectors", () => {
  expect(supportedEffortsForConfig("codex")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(supportedEffortsForConfig("claude")).toEqual(["minimal", "low", "medium", "high", "max"]);
  expect(supportedEffortsForConfig("kimi")).toEqual(["low", "high"]);
  expect(supportedEffortsForConfig("opencode")).toEqual([]);
  expect(effortOptionsForHarness("kimi")).toEqual(["low", "high"]);
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

test("derives runtime effort options from advertised ACP config options by harness", () => {
  const session = {
    configOptions: [
      {
        category: "effort",
        id: "thought_level",
        currentValue: "xhigh",
        options: [{ value: "low", name: "Low" }, { value: "xhigh", name: "X High" }],
      },
      {
        category: "effort",
        id: "thinking",
        currentValue: "enabled",
        options: [{ value: "disabled", name: "Off" }, { value: "enabled", name: "On" }],
      },
    ],
  };

  expect(runtimeEffortOptionsFromSession("claude", session)).toEqual({
    configId: "thought_level",
    current: "xhigh",
    available: [{ id: "low", name: "Low" }, { id: "xhigh", name: "X High" }],
  });
  expect(runtimeEffortOptionsFromSession("kimi", session)).toEqual({
    configId: "thinking",
    current: "high",
    available: [{ id: "low", name: "low" }, { id: "high", name: "high" }],
    values: { low: "disabled", high: "enabled" },
  });
  expect(runtimeEffortOptionsFromSession("codex", session)).toBeUndefined();
  expect(runtimeEffortOptionsFromSession("opencode", session)).toBeUndefined();
});
