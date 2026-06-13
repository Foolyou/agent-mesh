// Builds the "mesh briefing" injected into an agent's first prompt and served live
// by the mesh_briefing tool, so it understands it is a member of a collaborating
// mesh — its identity, role, the roster, who it can mail, which mesh tools to use,
// and the communication norms. Pure function of the Mesh model.
//
// The norms exist in three sizes so every surface stays consistent (single source):
//   buildNormsCard()    — full card, embedded at the end of the briefing
//   MAIL_WAKE_GUIDANCE  — short form appended to every mail wake prompt
//   tool descriptions   — one-line forms in mcp/mesh-services.ts (kept in sync by tests)
import type { AgentId } from "./acp/types";
import type { Mesh } from "./mesh";

/** One-line norms reminder appended to every mail delivery prompt. */
export const MAIL_WAKE_GUIDANCE =
  "Reply with send_mail ONLY if this mail asks you something ([REQ]) or you are blocked — " +
  "never send pure acknowledgements. When you reply, pass reply_to with this mail's number. " +
  "If you now need to wait for someone else's reply, just end your turn: mail is push-delivered " +
  "and will wake you; do not poll check_mail.";

/** The full mesh communication norms card. Embedded at the end of the briefing so the
 *  rules sit closest to the model's attention, and re-readable any time via mesh_briefing. */
export function buildNormsCard(): string {
  return [
    "Mesh communication rules (MUST follow):",
    "  - Mail is PUSH-delivered: when someone mails you, it arrives automatically as a new message in",
    "    your session. You NEVER need to poll for it.",
    "  - To wait for a reply: say what you are waiting for, then END YOUR TURN. The reply will wake you.",
    "    NEVER poll check_mail in a loop and NEVER sleep/busy-wait for mail to arrive.",
    "  - check_mail is ONLY for draining a backlog: call it when told you have pending mail (e.g. right",
    "    after spawning) or when a previous result said \"N more messages pending\". If it returns",
    "    \"no new mail\", do not call it again — end your turn instead.",
    "  - Start every mail body with one intent tag:",
    "      [REQ]  you need an answer — ask concrete questions and say so explicitly;",
    "      [FYI]  information only — the recipient must NOT reply;",
    "      [DONE] deliverable report — include what changed and the verification you actually ran",
    "             (commands + outcome); say plainly if a check was NOT run.",
    "  - Reply ONLY to [REQ] mail or when you are blocked. NEVER send pure acknowledgements",
    "    (\"got it\", \"ok, starting now\") — they burn the recipient's turn for nothing.",
    "  - Mail is delivered as [MAIL #N from X]. When replying, pass reply_to: N so the recipient knows",
    "    exactly which mail you answer. When your mesh works with task slugs, tag outgoing mail with",
    "    task: \"<slug>\" so parallel threads stay separable.",
  ].join("\n");
}

export function buildMeshBriefing(mesh: Mesh, agentId: AgentId): string {
  const me = mesh.agent(agentId);
  if (!me) return "";
  const router = mesh.router;
  const isRouter = me.role === "router";

  const roster = mesh.agents
    .map((a) => {
      const tag = a.id === agentId ? " (you)" : a.id === router.id ? " (router)" : "";
      const reach = mesh.agents
        .filter((o) => o.id !== a.id && mesh.canMail(a.id, o.id))
        .map((o) => o.id);
      return `  - ${a.id}${tag} — ${a.harness}, ${a.role}; can mail: ${reach.join(", ") || "(none)"}`;
    })
    .join("\n");

  const myReach = mesh.agents
    .filter((o) => o.id !== agentId && mesh.canMail(agentId, o.id))
    .map((o) => o.id);

  const lines: string[] = [];
  lines.push("[MESH BRIEFING]");
  lines.push(`You are "${agentId}", a ${me.role} agent in a multi-agent mesh named "${mesh.name}".`);
  lines.push(
    "You are NOT working alone: this mesh is a team of heterogeneous coding agents, each running in " +
      "its own workspace and collaborating through injected mesh tools. Treat the other agents as real " +
      "teammates you can delegate to and hand work off to.",
  );
  lines.push("");
  lines.push("Mesh roster:");
  lines.push(roster);
  lines.push("");
  lines.push(`The human reaches this mesh through the router (${router.id}).`);
  if (isRouter) {
    lines.push(
      "That router is YOU — you are the gateway. Understand the user's goal, then coordinate the " +
        "members: delegate sub-tasks with send_mail, gather their replies, and respond to the user yourself.",
    );
  } else {
    lines.push(
      `You receive work as direct prompts and as mail from the router or peers. When you finish a piece ` +
        `of work, send your result or hand-off back with send_mail (usually to the router, ${router.id}).`,
    );
  }
  lines.push("");
  lines.push("Your mesh tools (already connected to this session):");
  lines.push(
    "Mesh communication and mesh state access happen through these injected MCP tools. Do not look " +
      "for AGENT_ROOM_* environment variables, and do not read or write any mailbox file directly.",
  );
  lines.push(
    `  - send_mail(to, body, reply_to?, task?): delegate work, ask a question, or report a result to ` +
      `another agent. You may mail: ${myReach.join(", ") || "(no one — you have no outgoing edges)"}.`,
  );
  lines.push(
    "  - check_mail(): drain backlogged mail. Only needed when told you have pending mail; new mail " +
      "is otherwise pushed to you automatically.",
  );
  lines.push("  - mesh_status(): inspect the live mesh and peer busy/idle activity.");
  lines.push(
    "  - mesh_briefing(): re-read this briefing (live roster, norms, charter, your instructions) at " +
      "any time — for example after context compaction, or whenever you are unsure of the rules.",
  );
  if (isRouter) {
    lines.push("  - interrupt(target, reason): cancel a member's current turn (router only).");
  }
  lines.push(
    "Prefer using these tools to collaborate rather than assuming you must do everything yourself.",
  );

  lines.push("");
  lines.push("Attaching images/documents for the user:");
  lines.push(
    "  - Write: put files under `$AGENT_MESH_ARTIFACTS/<file>`; the directory is created for you " +
      "when this agent starts. Prefer tmp + rename for atomic writes so the frontend never reads a partial file as a broken image.",
  );
  lines.push("  - Reference: use `![alt](artifact:<file>)` or `[name](artifact:<file>)` in Markdown.");
  lines.push("  - Forward someone else's artifact: use `artifact://<owner-agent>/<file>` so ownership is explicit.");
  lines.push(
    "  - This directory is outside your worktree, so it does not dirty the user's repository; it is removed automatically when the mesh is deleted.",
  );

  const charter = mesh.charter;
  if (charter) {
    lines.push("");
    lines.push("Team charter — the shared goal and working norms for this mesh. Follow it in all your work:");
    lines.push(charter.replace(/^/gm, "  "));
  }
  const instructions = me.instructions?.trim();
  if (instructions) {
    lines.push("");
    lines.push("Your role-specific instructions — additional guidance for you specifically (only you see this):");
    lines.push(instructions.replace(/^/gm, "  "));
  }

  lines.push("");
  lines.push(buildNormsCard());
  return lines.join("\n");
}
