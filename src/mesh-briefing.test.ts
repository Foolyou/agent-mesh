import { test, expect } from "bun:test";
import { Mesh } from "./mesh";
import { buildMeshBriefing } from "./mesh-briefing";
import type { MeshConfig } from "./acp/types";

const cfg: MeshConfig = {
  name: "demo",
  agents: [
    { id: "router", harness: "claude", project: "p", role: "router" },
    { id: "codex-1", harness: "codex", project: "p", role: "member" },
    { id: "opencode-1", harness: "opencode", project: "p", role: "member" },
  ],
  edges: [
    ["router", "codex-1"],
    ["router", "opencode-1"],
    ["codex-1", "opencode-1"],
  ],
};

test("router briefing names the agent, role, mesh, peers, and gateway duty + router tools", () => {
  const b = buildMeshBriefing(new Mesh(cfg), "router");
  expect(b).toContain('"router"');
  expect(b).toContain("router agent");
  expect(b).toContain('mesh named "demo"');
  expect(b).toContain("codex-1");
  expect(b).toContain("opencode-1");
  expect(b).toMatch(/gateway|coordinate/i);
  expect(b).toContain("send_mail");
  expect(b).toContain("mesh_status"); // router-only tool present in router briefing
  expect(b).toContain("interrupt");
});

test("member briefing tells it to report back to the router and lists reachable peers", () => {
  const b = buildMeshBriefing(new Mesh(cfg), "codex-1");
  expect(b).toContain('"codex-1"');
  expect(b).toContain("member agent");
  expect(b).toMatch(/to the router/i);
  expect(b).toContain("opencode-1"); // codex-1 has an edge to opencode-1
  expect(b).not.toContain("mesh_status"); // router-only tools are not advertised to members
});

test("an agent with no outgoing edges is told so", () => {
  const isolated: MeshConfig = {
    name: "solo",
    agents: [
      { id: "router", harness: "claude", project: "p", role: "router" },
      { id: "m", harness: "codex", project: "p", role: "member" },
    ],
    edges: [["router", "m"]],
  };
  const b = buildMeshBriefing(new Mesh(isolated), "m");
  expect(b).toContain("no outgoing edges");
});

test("team charter is injected when present and omitted when absent", () => {
  const withCharter = new Mesh({ ...cfg, charter: "Ship a tiny CLI. Be concise. Always write a test." });
  const b = buildMeshBriefing(withCharter, "codex-1");
  expect(b).toContain("Team charter");
  expect(b).toContain("Ship a tiny CLI");
  expect(buildMeshBriefing(new Mesh(cfg), "codex-1")).not.toContain("Team charter");
});

test("unknown agent yields an empty briefing", () => {
  expect(buildMeshBriefing(new Mesh(cfg), "ghost")).toBe("");
});
