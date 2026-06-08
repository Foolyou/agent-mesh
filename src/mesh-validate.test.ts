// src/mesh-validate.test.ts
import { test, expect } from "bun:test";
import { validateMeshConfig } from "./mesh-validate";
import type { MeshConfig } from "./acp/types";

const ok: MeshConfig = {
  name: "good",
  agents: [
    { id: "r", harness: "claude", project: "test_mesh_0", role: "router" },
    { id: "m", harness: "codex", project: "test_mesh_0", role: "member" },
  ],
  edges: [["r", "m"]],
};

test("accepts a valid mesh", () => {
  expect(() => validateMeshConfig(ok)).not.toThrow();
});

test("rejects unsafe names", () => {
  expect(() => validateMeshConfig({ ...ok, name: "../escape" })).toThrow(/name/i);
});

test("accepts a valid per-agent effort and rejects an invalid one", () => {
  expect(() => validateMeshConfig({ ...ok, agents: ok.agents.map((a) => ({ ...a, effort: "high" as const })) })).not.toThrow();
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], effort: "turbo" as any }, ok.agents[1]] })).toThrow(/effort/i);
});

test("mode: known safe mode accepted; unknown / wrong-harness / blank rejected", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], mode: "plan" }, ok.agents[1]] })).not.toThrow();
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], mode: "  " }, ok.agents[1]] })).toThrow(/mode/i);
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], mode: "yolo" }, ok.agents[1]] })).toThrow(/not a known/i);
  // "read-only" is a codex mode — rejected on a claude agent (no cross-harness / arbitrary ids)
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], mode: "read-only" }, ok.agents[1]] })).toThrow(/not a known/i);
});

test("mode: a permission-bypassing mode is rejected at create time unless explicitly opted in", () => {
  const cfg = { ...ok, agents: [{ ...ok.agents[0], mode: "bypassPermissions" }, ok.agents[1]] };
  delete process.env.ALLOW_UNSAFE_MESH_MODES;
  expect(() => validateMeshConfig(cfg)).toThrow(/permission prompts|ALLOW_UNSAFE/i);
  process.env.ALLOW_UNSAFE_MESH_MODES = "1";
  try {
    expect(() => validateMeshConfig(cfg)).not.toThrow();
  } finally {
    delete process.env.ALLOW_UNSAFE_MESH_MODES;
  }
});

test("rejects names containing '..' (path traversal)", () => {
  expect(() => validateMeshConfig({ ...ok, name: "a..b" })).toThrow(/name/i);
  expect(() => validateMeshConfig({ ...ok, name: ".." })).toThrow(/name/i);
});

test("rejects empty agents", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [] })).toThrow(/at least one/i);
});

test("requires exactly one router", () => {
  const two = { ...ok, agents: ok.agents.map((a) => ({ ...a, role: "router" as const })) };
  expect(() => validateMeshConfig(two)).toThrow(/exactly one router/i);
});

test("rejects unknown harness", () => {
  const bad = { ...ok, agents: [{ ...ok.agents[0]!, harness: "gpt" as any }, ok.agents[1]!] };
  expect(() => validateMeshConfig(bad)).toThrow(/harness/i);
});

test("rejects duplicate agent ids", () => {
  const dup = { ...ok, agents: [ok.agents[0]!, { ...ok.agents[1]!, id: "r" }] };
  expect(() => validateMeshConfig(dup)).toThrow(/duplicate/i);
});

test("rejects edges referencing unknown agents", () => {
  expect(() => validateMeshConfig({ ...ok, edges: [["r", "ghost"]] })).toThrow(/edge/i);
});

test("rejects absolute project paths", () => {
  const abs = { ...ok, agents: [{ ...ok.agents[0]!, project: "/etc" }, ok.agents[1]!] };
  expect(() => validateMeshConfig(abs)).toThrow(/relative/i);
});

test("accepts an optional charter and rejects an overly long one", () => {
  expect(() => validateMeshConfig({ ...ok, charter: "Be concise. Write tests." })).not.toThrow();
  expect(() => validateMeshConfig({ ...ok, charter: "x".repeat(4001) })).toThrow(/too long/i);
});

test("accepts optional per-agent instructions and ignores blank ones", () => {
  expect(() =>
    validateMeshConfig({
      ...ok,
      agents: [{ ...ok.agents[0], instructions: "Focus on routing and handoffs." }, { ...ok.agents[1], instructions: "   " }],
    }),
  ).not.toThrow();
});

test("rejects overly long per-agent instructions", () => {
  expect(() =>
    validateMeshConfig({
      ...ok,
      agents: [{ ...ok.agents[0], instructions: "x".repeat(4001) }, ok.agents[1]],
    }),
  ).toThrow(/instructions.*too long/i);
});
