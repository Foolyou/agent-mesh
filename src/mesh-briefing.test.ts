import { test, expect } from "bun:test";
import { Mesh } from "./mesh";
import { buildMeshBriefing, buildNormsCard, MAIL_WAKE_GUIDANCE } from "./mesh-briefing";
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

test("team charter is injected when present and explicitly marked absent when missing", () => {
  const withCharter = new Mesh({ ...cfg, charter: "Ship a tiny CLI. Be concise. Always write a test." });
  const b = buildMeshBriefing(withCharter, "codex-1");
  expect(b).toContain("Team charter — the shared goal");
  expect(b).toContain("Ship a tiny CLI");
  expect(b).not.toContain("no team charter defined");
  // Absent: explicit grounding line, NOT a silent omission.
  const absent = buildMeshBriefing(new Mesh(cfg), "codex-1");
  expect(absent).toContain("this mesh configuration has no team charter defined");
  expect(absent).toContain("do not invent one");
});

test("charter-absence wording is scoped to the mesh config and does not negate other guidance", () => {
  const absent = buildMeshBriefing(new Mesh(cfg), "codex-1");
  expect(absent).toMatch(/system, developer, harness, project \(CLAUDE\.md\/AGENTS\.md\), and user instructions/);
  expect(absent).toContain("their normal channels");
});

test("per-agent instructions are injected for that agent with indentation", () => {
  const mesh = new Mesh({
    ...cfg,
    agents: cfg.agents.map((a) =>
      a.id === "codex-1" ? { ...a, instructions: "Focus on implementation.\nReport blockers early." } : a,
    ),
  });
  const b = buildMeshBriefing(mesh, "codex-1");
  expect(b).toContain("Your role-specific instructions — additional guidance");
  expect(b).toContain("  Focus on implementation.\n  Report blockers early.");
  // opencode-1 has no instructions of its own → it gets the explicit-absence line, not codex-1's text.
  const other = buildMeshBriefing(mesh, "opencode-1");
  expect(other).not.toContain("Focus on implementation");
  expect(other).toContain("defines no per-agent role instructions for you");
});

test("absent per-agent instructions emit an explicit, scoped grounding line (not a silent gap)", () => {
  const base = buildMeshBriefing(new Mesh(cfg), "codex-1");
  const blank = buildMeshBriefing(
    new Mesh({
      ...cfg,
      agents: cfg.agents.map((a) => (a.id === "codex-1" ? { ...a, instructions: "   \n\t" } : a)),
    }),
    "codex-1",
  );
  // Blank-after-trim is treated identically to missing.
  expect(blank).toBe(base);
  expect(base).toContain("Your role-specific instructions — this mesh configuration defines no per-agent role");
  // Absence wording must NOT claim the agent has no instructions at all / must not negate higher-priority sources.
  expect(base).toMatch(/continue following the system, developer, harness, project \(CLAUDE\.md\/AGENTS\.md\), and user instructions/);
  expect(base).toContain("Do not infer extra duties from this absence");
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

test("per-agent instructions can appear alongside an absent-charter grounding line", () => {
  const b = buildMeshBriefing(
    new Mesh({
      ...cfg,
      agents: cfg.agents.map((a) => (a.id === "codex-1" ? { ...a, instructions: "Solo private guidance." } : a)),
    }),
    "codex-1",
  );
  expect(b).not.toContain("Team charter — the shared goal"); // no present-charter section
  expect(b).toContain("this mesh configuration has no team charter defined"); // explicit absence instead
  expect(b).toContain("Your role-specific instructions — additional guidance");
  expect(b).toContain("  Solo private guidance.");
});

test("norms card carries the identity/charter discipline (consult mesh_briefing/mesh_status, answer 'not specified')", () => {
  const card = buildNormsCard();
  expect(card).toContain("mesh_briefing");
  expect(card).toContain("mesh_status");
  expect(card).toMatch(/identity, your role, the team\/mesh setup, the roster, or the charter/);
  expect(card).toMatch(/not specified/);
  expect(card).toContain("do not infer or fill it in");
  // The discipline rides every briefing because the card is embedded at the end.
  expect(buildMeshBriefing(new Mesh(cfg), "codex-1")).toContain("retrieve the authoritative current");
});

test("briefing tells agents to attach user-visible artifacts through the official artifact directory", () => {
  const b = buildMeshBriefing(new Mesh(cfg), "codex-1");
  expect(b).toMatch(/Attaching images\/documents/i);
  expect(b).toContain("$AGENT_MESH_ARTIFACTS/<file>");
  expect(b).toContain("artifact:<file>");
  expect(b).toContain("artifact://<owner-agent>/<file>");
  expect(b).toMatch(/outside your worktree/i);
  expect(b).not.toMatch(/relative to your CWD/i);
});

test("unknown agent yields an empty briefing", () => {
  expect(buildMeshBriefing(new Mesh(cfg), "ghost")).toBe("");
});

test("briefing embeds the communication norms card at the end (push model, intent tags, no acks)", () => {
  const b = buildMeshBriefing(new Mesh(cfg), "codex-1");
  expect(b).toContain("Mesh communication rules (MUST follow):");
  expect(b).toContain("PUSH-delivered");
  expect(b).toContain("END YOUR TURN");
  expect(b).toContain("[REQ]");
  expect(b).toContain("[FYI]");
  expect(b).toContain("[DONE]");
  expect(b).toMatch(/NEVER send pure acknowledgements/);
  // The norms card is the LAST section so it sits closest to the model's attention.
  expect(b.indexOf("Mesh communication rules")).toBeGreaterThan(b.indexOf("Attaching images/documents"));
});

test("norms card and wake guidance agree on the core rules (single source, no drift)", () => {
  expect(buildNormsCard()).toContain("reply_to");
  expect(MAIL_WAKE_GUIDANCE).toContain("reply_to");
  expect(MAIL_WAKE_GUIDANCE).toContain("end your turn");
  expect(MAIL_WAKE_GUIDANCE).toContain("do not poll check_mail");
});

test("briefing advertises mesh_briefing and frames check_mail as backlog-only", () => {
  const b = buildMeshBriefing(new Mesh(cfg), "codex-1");
  expect(b).toContain("mesh_briefing()");
  expect(b).toMatch(/check_mail\(\): drain backlogged mail/);
  expect(b).toContain("send_mail(to, body, reply_to?, task?)");
});
