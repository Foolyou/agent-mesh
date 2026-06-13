// src/mesh-validate.test.ts
import { test, expect } from "bun:test";
import { validateAddAgent, validateMeshConfig } from "./mesh-validate";
import type { HarnessId, MeshConfig, ThinkingEffort } from "./acp/types";

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

test("validates effort per harness", () => {
  const accepted: Record<HarnessId, ThinkingEffort[]> = {
    codex: ["low", "medium", "high", "xhigh"],
    claude: ["minimal", "low", "medium", "high"],
    kimi: ["low", "high"],
    opencode: [],
  };
  const all = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

  for (const harness of Object.keys(accepted) as HarnessId[]) {
    for (const effort of all) {
      const cfg = { ...ok, agents: [{ ...ok.agents[0], harness, effort: effort as any }, ok.agents[1]] };
      const assertion = expect(() => validateMeshConfig(cfg));
      if ((accepted[harness] as readonly string[]).includes(effort)) assertion.not.toThrow();
      else assertion.toThrow(new RegExp(`effort.*${harness}`, "i"));
    }
  }
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], effort: "turbo" as any }, ok.agents[1]] })).toThrow(/effort/i);
});

test("validates add-agent effort per harness", () => {
  expect(() => validateAddAgent(ok, { id: "c2", harness: "codex", project: "test_mesh_0", role: "member", effort: "xhigh" })).not.toThrow();
  expect(() => validateAddAgent(ok, { id: "k2", harness: "kimi", project: "test_mesh_0", role: "member", effort: "medium" })).toThrow(/effort.*kimi/i);
  expect(() => validateAddAgent(ok, { id: "o2", harness: "opencode", project: "test_mesh_0", role: "member", effort: "low" })).toThrow(/effort.*opencode/i);
});

test("accepts arbitrary cached mode/model strings", () => {
  expect(() =>
    validateMeshConfig({
      ...ok,
      agents: [{ ...ok.agents[0], mode: "yolo custom mode", model: "vendor/model:latest" }, ok.agents[1]],
    }),
  ).not.toThrow();
});

test("accepts opencodePermission on opencode agents and rejects invalid values", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [ok.agents[0], { ...ok.agents[1], harness: "opencode", opencodePermission: "allow" }] })).not.toThrow();
  expect(() => validateMeshConfig({ ...ok, agents: [ok.agents[0], { ...ok.agents[1], harness: "opencode", opencodePermission: "ask" }] })).not.toThrow();
  expect(() => validateMeshConfig({ ...ok, agents: [ok.agents[0], { ...ok.agents[1], harness: "opencode", opencodePermission: "yes" as any }] })).toThrow(/opencodePermission/i);
});

test("rejects opencodePermission on non-opencode harnesses (they use mode)", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [{ ...ok.agents[0], opencodePermission: "allow" as any }, ok.agents[1]] })).toThrow(/opencodePermission/i);
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

test("accepts optional autoCompact settings", () => {
  expect(() => validateMeshConfig({ ...ok, autoCompact: { enabled: true, threshold: "85%" } })).not.toThrow();
  expect(() => validateMeshConfig({ ...ok, autoCompact: { enabled: false, threshold: "-20000" } })).not.toThrow();
});

test("accepts missing autoCompact for old mesh configs", () => {
  expect(() => validateMeshConfig(ok)).not.toThrow();
});

test("rejects invalid autoCompact settings", () => {
  expect(() => validateMeshConfig({ ...ok, autoCompact: { enabled: true, threshold: "0%" } })).toThrow(/autoCompact/i);
  expect(() => validateMeshConfig({ ...ok, autoCompact: { enabled: "yes" as any, threshold: "85%" } })).toThrow(/autoCompact/i);
  expect(() => validateMeshConfig({ ...ok, autoCompact: { enabled: true, threshold: "" } })).toThrow(/autoCompact/i);
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
