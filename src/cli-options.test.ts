import { test, expect } from "bun:test";
import { masterHarnessPassthrough, parseMasterHarness } from "./cli-options";

test("parseMasterHarness defaults to codex", () => {
  expect(parseMasterHarness([], {})).toBe("codex");
});

test("parseMasterHarness accepts --master-harness", () => {
  expect(parseMasterHarness(["--master-harness", "claude"], {})).toBe("claude");
});

test("parseMasterHarness accepts MESH_MASTER_HARNESS", () => {
  expect(parseMasterHarness([], { MESH_MASTER_HARNESS: "opencode" })).toBe("opencode");
});

test("parseMasterHarness rejects unknown harnesses", () => {
  expect(() => parseMasterHarness(["--master-harness", "gpt"], {})).toThrow(/invalid master harness/i);
});

test("masterHarnessPassthrough forwards the selected harness to service backends", () => {
  expect(masterHarnessPassthrough("kimi")).toEqual(["--master-harness", "kimi"]);
});
