import { expect, test } from "bun:test";
import {
  effortOptionsForHarness,
  runtimeEffortConfig,
  runtimeEffortOptionsFromSession,
  supportsRuntimeEffort,
  supportedEffortsForConfig,
  supportsThinkingToggle,
  kimiThinkingEnabled,
  kimiBaseModel,
  kimiModelForThinking,
} from "./harness-utils";
import type { HarnessId } from "./acp/types";

test("declares effort options per harness for UI selectors", () => {
  expect(supportedEffortsForConfig("codex")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(supportedEffortsForConfig("claude")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  // kimi is not a reasoning-effort harness — its thinking is a model-variant toggle.
  expect(supportedEffortsForConfig("kimi")).toEqual([]);
  expect(supportedEffortsForConfig("opencode")).toEqual([]);
  expect(effortOptionsForHarness("kimi")).toEqual([]);
});

test("declares runtime effort switching only for claude", () => {
  const runtime = (["codex", "claude", "kimi", "opencode"] as HarnessId[]).filter((h) => supportsRuntimeEffort(h));
  expect(runtime).toEqual(["claude"]);
});

test("kimi thinking is a model-variant toggle, not an effort", () => {
  expect((["codex", "claude", "kimi", "opencode"] as HarnessId[]).filter((h) => supportsThinkingToggle(h))).toEqual(["kimi"]);
  expect(kimiThinkingEnabled("kimi-k2")).toBe(false);
  expect(kimiThinkingEnabled("kimi-k2,thinking")).toBe(true);
  expect(kimiThinkingEnabled(undefined)).toBe(false);
  expect(kimiBaseModel("kimi-k2,thinking")).toBe("kimi-k2");
  expect(kimiBaseModel("kimi-k2")).toBe("kimi-k2");
  expect(kimiModelForThinking("kimi-k2", true)).toBe("kimi-k2,thinking");
  expect(kimiModelForThinking("kimi-k2,thinking", false)).toBe("kimi-k2");
  // idempotent: toggling on when already on doesn't double-append.
  expect(kimiModelForThinking("kimi-k2,thinking", true)).toBe("kimi-k2,thinking");
});

test("maps runtime effort config per harness", () => {
  // claude dropped `minimal` (Zed-aligned set low|medium|high|xhigh|max) → no longer mapped.
  expect(runtimeEffortConfig("claude", "minimal")).toBeUndefined();
  expect(runtimeEffortConfig("claude", "high")).toEqual({ configId: "thought_level", value: "high" });
  // max is now a first-class claude effort, so the static path maps it without advertisement.
  expect(runtimeEffortConfig("claude", "max")).toEqual({ configId: "thought_level", value: "max" });
  expect(runtimeEffortConfig("claude", "max", { configId: "output_config.effort", current: "max", available: [{ id: "max", name: "Max" }] })).toEqual({ configId: "output_config.effort", value: "max" });
  // kimi no longer maps an effort config option (thinking is a model variant).
  expect(runtimeEffortConfig("kimi", "low")).toBeUndefined();
  expect(runtimeEffortConfig("kimi", "high")).toBeUndefined();
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
  // kimi no longer derives a runtime EFFORT option from config options — thinking is a
  // model variant, so even an advertised "thinking" config option is not surfaced as effort.
  expect(runtimeEffortOptionsFromSession("kimi", session)).toBeUndefined();
  expect(runtimeEffortOptionsFromSession("codex", session)).toBeUndefined();
  expect(runtimeEffortOptionsFromSession("opencode", session)).toBeUndefined();
});

test("recognizes the real Claude wrapper effort shape { id: 'effort', category: 'thought_level' }", () => {
  // This is the shape the installed Claude ACP wrapper actually advertises. Before the
  // parser fix it matched none of the predicates and discovery fell back to the static list.
  const session = {
    configOptions: [
      {
        id: "effort",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "X-High" },
          { value: "max", name: "Max" },
        ],
      },
    ],
  };
  expect(runtimeEffortOptionsFromSession("claude", session)).toEqual({
    configId: "effort", // forwards the real option id so setConfigOption targets it
    current: "high",
    available: [
      { id: "low", name: "Low" },
      { id: "medium", name: "Medium" },
      { id: "high", name: "High" },
      { id: "xhigh", name: "X-High" },
      { id: "max", name: "Max" },
    ],
  });
});

test("still recognizes the legacy output_config.effort alias", () => {
  const session = {
    configOptions: [
      { id: "output_config.effort", currentValue: "max", options: [{ value: "high", name: "High" }, { value: "max", name: "Max" }] },
    ],
  };
  expect(runtimeEffortOptionsFromSession("claude", session)).toEqual({
    configId: "output_config.effort",
    current: "max",
    available: [{ id: "high", name: "High" }, { id: "max", name: "Max" }],
  });
});
