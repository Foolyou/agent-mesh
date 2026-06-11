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
  edges: [{ from: "r", to: "m" }],
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

test("accepts arbitrary cached mode/model strings", () => {
  expect(() =>
    validateMeshConfig({
      ...ok,
      agents: [{ ...ok.agents[0], mode: "yolo custom mode", model: "vendor/model:latest" }, ok.agents[1]],
    }),
  ).not.toThrow();
});

test("accepts bypass for supported harnesses and rejects invalid bypass fields", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], bypass: true }, { ...ok.agents[1], bypass: false }] })).not.toThrow();
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], bypass: "yes" as any }, ok.agents[1]] })).toThrow(/bypass/i);
});

test("rejects bypass on kimi because it has no permission bypass mechanism", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], harness: "kimi", bypass: true }, ok.agents[1]] })).toThrow(/bypass.*kimi/i);
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
  expect(() => validateMeshConfig({ ...ok, edges: [{ from: "r", to: "ghost" }] })).toThrow(/edge/i);
});

test("accepts old tuple edges and new object edges", () => {
  expect(() =>
    validateMeshConfig({
      ...ok,
      edges: [["r", "m"], { from: "m", to: "r" }] as any,
    }),
  ).not.toThrow();
});

test("rejects steer edges targeting the router", () => {
  expect(() => validateMeshConfig({ ...ok, edges: [{ from: "m", to: "r", steer: true }] })).toThrow(/steer.*router/i);
});

test("accepts absolute project paths", () => {
  const abs = { ...ok, agents: [{ ...ok.agents[0]!, project: "/etc" }, ok.agents[1]!] };
  expect(() => validateMeshConfig(abs)).not.toThrow();
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

test("accepts lazy member agents", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [ok.agents[0]!, { ...ok.agents[1]!, lazy: true }] })).not.toThrow();
});

test("rejects lazy routers", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0]!, lazy: true }, ok.agents[1]!] })).toThrow(/router.*lazy/i);
});
