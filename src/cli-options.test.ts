import { test, expect } from "bun:test";
import { assistantCliDeprecationWarnings, assistantHarnessPassthrough, noAssistantSelected, parseAssistantHarness } from "./cli-options";

test("parseAssistantHarness defaults to codex", () => {
  expect(parseAssistantHarness([], {})).toBe("codex");
});

test("parseAssistantHarness accepts --assistant-harness", () => {
  expect(parseAssistantHarness(["--assistant-harness", "claude"], {})).toBe("claude");
});

test("parseAssistantHarness accepts legacy --master-harness", () => {
  expect(parseAssistantHarness(["--master-harness", "claude"], {})).toBe("claude");
});

test("parseAssistantHarness accepts MESH_ASSISTANT_HARNESS", () => {
  expect(parseAssistantHarness([], { MESH_ASSISTANT_HARNESS: "opencode" })).toBe("opencode");
});

test("parseAssistantHarness accepts legacy MESH_MASTER_HARNESS", () => {
  expect(parseAssistantHarness([], { MESH_MASTER_HARNESS: "opencode" })).toBe("opencode");
});

test("parseAssistantHarness rejects unknown harnesses", () => {
  expect(() => parseAssistantHarness(["--assistant-harness", "gpt"], {})).toThrow(/invalid assistant harness/i);
});

test("assistantHarnessPassthrough forwards the selected harness to service backends", () => {
  expect(assistantHarnessPassthrough("kimi")).toEqual(["--assistant-harness", "kimi"]);
});

test("assistantCliDeprecationWarnings reports legacy assistant options", () => {
  expect(assistantCliDeprecationWarnings(["--no-mesh-assistant", "--no-master", "--master-harness", "claude"], { MESH_MASTER_HARNESS: "codex" })).toEqual([
    "--no-mesh-assistant is deprecated; use --no-assistant",
    "--no-master is deprecated; use --no-assistant",
    "--master-harness is deprecated; use --assistant-harness",
    "MESH_MASTER_HARNESS is deprecated; use MESH_ASSISTANT_HARNESS",
  ]);
});

test("assistantCliDeprecationWarnings ignores canonical assistant options", () => {
  expect(assistantCliDeprecationWarnings(["--no-assistant", "--assistant-harness", "claude"], { MESH_ASSISTANT_HARNESS: "codex" })).toEqual([]);
});

test("noAssistantSelected accepts canonical and legacy skip flags", () => {
  expect(noAssistantSelected(["--no-assistant"])).toBe(true);
  expect(noAssistantSelected(["--no-mesh-assistant"])).toBe(true);
  expect(noAssistantSelected(["--no-master"])).toBe(true);
  expect(noAssistantSelected([])).toBe(false);
});
