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

test("accepts a per-agent mode (any non-empty string) and rejects a blank one", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], mode: "plan" }, ok.agents[1]] })).not.toThrow();
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], mode: "  " }, ok.agents[1]] })).toThrow(/mode/i);
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
