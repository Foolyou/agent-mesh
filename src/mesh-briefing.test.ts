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
    { from: "router", to: "codex-1" },
    { from: "router", to: "opencode-1" },
    { from: "codex-1", to: "opencode-1" },
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
    edges: [{ from: "router", to: "m" }],
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

test("per-agent instructions are injected for that agent with indentation", () => {
  const mesh = new Mesh({
    ...cfg,
    agents: cfg.agents.map((a) =>
      a.id === "codex-1" ? { ...a, instructions: "Focus on implementation.\nReport blockers early." } : a,
    ),
  });
  const b = buildMeshBriefing(mesh, "codex-1");
  expect(b).toContain("Your role-specific instructions");
  expect(b).toContain("  Focus on implementation.\n  Report blockers early.");
  expect(buildMeshBriefing(mesh, "opencode-1")).not.toContain("Your role-specific instructions");
});

test("blank or missing per-agent instructions leave the briefing unchanged", () => {
  const base = buildMeshBriefing(new Mesh(cfg), "codex-1");
  const blank = buildMeshBriefing(
    new Mesh({
      ...cfg,
      agents: cfg.agents.map((a) => (a.id === "codex-1" ? { ...a, instructions: "   \n\t" } : a)),
    }),
    "codex-1",
  );
  expect(blank).toBe(base);
  expect(base).not.toContain("Your role-specific instructions");
});

test("team charter appears before per-agent instructions when both are present", () => {
  const b = buildMeshBriefing(
    new Mesh({
      ...cfg,
      charter: "Shared goal first.",
      agents: cfg.agents.map((a) => (a.id === "codex-1" ? { ...a, instructions: "Private guidance second." } : a)),
    }),
    "codex-1",
  );
  const charterIndex = b.indexOf("Team charter");
  const instructionsIndex = b.indexOf("Your role-specific instructions");
  expect(charterIndex).toBeGreaterThanOrEqual(0);
  expect(instructionsIndex).toBeGreaterThan(charterIndex);
});

test("per-agent instructions can appear without a team charter", () => {
  const b = buildMeshBriefing(
    new Mesh({
      ...cfg,
      agents: cfg.agents.map((a) => (a.id === "codex-1" ? { ...a, instructions: "Solo private guidance." } : a)),
    }),
    "codex-1",
  );
  expect(b).not.toContain("Team charter");
  expect(b).toContain("Your role-specific instructions");
  expect(b).toContain("  Solo private guidance.");
});

test("briefing tells agents to write Markdown file references with paths relative to cwd", () => {
  const b = buildMeshBriefing(new Mesh(cfg), "codex-1");
  expect(b).toMatch(/file references in Markdown/i);
  expect(b).toMatch(/relative to your CWD/i);
  expect(b).toContain("artifacts/analysis.md"); // example using a subdir prefix
  expect(b).toMatch(/absolute paths/i); // explicit warning that absolute paths are stripped
});

test("unknown agent yields an empty briefing", () => {
  expect(buildMeshBriefing(new Mesh(cfg), "ghost")).toBe("");
});
