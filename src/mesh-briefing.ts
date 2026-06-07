// Builds the one-time "mesh briefing" injected into an agent's first prompt so it
// understands it is a member of a collaborating mesh — its identity, role, the roster,
// who it can mail, and which mesh tools to use. Pure function of the Mesh model.
import type { AgentId } from "./acp/types";
import type { Mesh } from "./mesh";

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
      "its own workspace and collaborating through a shared mailbox. Treat the other agents as real " +
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
    `  - send_mail(to, body): delegate work, ask a question, or report a result to another agent. ` +
      `You may mail: ${myReach.join(", ") || "(no one — you have no outgoing edges)"}.`,
  );
  lines.push("  - check_mail(): read new mail addressed to you.");
  if (isRouter) {
    lines.push("  - interrupt(target, reason): cancel a member's current turn (router only).");
    lines.push("  - mesh_status(): inspect the live mesh and member statuses (router only).");
  }
  lines.push(
    "Prefer using these tools to collaborate rather than assuming you must do everything yourself.",
  );

  const charter = mesh.charter;
  if (charter) {
    lines.push("");
    lines.push("Team charter — the shared goal and working norms for this mesh. Follow it in all your work:");
    lines.push(charter.replace(/^/gm, "  "));
  }
  return lines.join("\n");
}
