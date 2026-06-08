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
  expect(b).toContain("mesh_status");
  expect(b).toContain("busy/idle");
  expect(b).toContain("interrupt");
});

test("member briefing tells it to report back to the router and lists reachable peers", () => {
  const b = buildMeshBriefing(new Mesh(cfg), "codex-1");
  expect(b).toContain('"codex-1"');
  expect(b).toContain("member agent");
  expect(b).toMatch(/to the router/i);
  expect(b).toContain("opencode-1"); // codex-1 has an edge to opencode-1
  expect(b).toContain("mesh_status");
  expect(b).toContain("busy/idle");
  expect(b).not.toContain("interrupt(target, reason)"); // interrupt remains router-only
});

test("briefing points agents to injected MCP tools, not env vars or mailbox files", () => {
  const b = buildMeshBriefing(new Mesh(cfg), "codex-1");
  expect(b).toContain("injected MCP tools");
  expect(b).toContain("Do not look for AGENT_ROOM_* environment variables");
  expect(b).toContain("do not read or write any mailbox file directly");
  expect(b).not.toContain("shared mailbox");
  expect(b).not.toContain("AGENT_ROOM_MAILBOX");
  expect(b).not.toContain(".mesh/mailbox");
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
