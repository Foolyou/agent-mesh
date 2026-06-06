// Core domain types for the Agent Mesh control plane.
// Re-export the ACP schema/classes under `schema` for convenient access.
export * as schema from "@zed-industries/agent-client-protocol";

export type HarnessId = "codex" | "opencode" | "claude";
export type AgentRole = "router" | "member";

/** Unique within a mesh, e.g. "codex-1". */
export type AgentId = string;

export interface AgentConfig {
  id: AgentId;
  harness: HarnessId;
  /** Working directory (the "Project" layer), relative to repo root. */
  project: string;
  role: AgentRole;
}

export interface MeshConfig {
  name: string;
  agents: AgentConfig[];
  /** Directed edges: [from, to] means `from` may send mail to `to`. */
  edges: Array<[AgentId, AgentId]>;
}

export type AgentStatus = "spawning" | "ready" | "dead";

export type MeshEvent =
  | { kind: "agent_status"; agent: AgentId; status: AgentStatus; detail?: string; ts: string }
  | { kind: "update"; agent: AgentId; update: unknown; ts: string }
  | { kind: "mail"; from: AgentId; to: AgentId; body: string; ts: string }
  | {
      kind: "permission";
      agent: AgentId;
      requestId: string;
      question: string;
      options: { id: string; name: string; kind?: string }[];
      ts: string;
    }
  | {
      kind: "permission_resolved";
      agent: AgentId;
      requestId: string;
      optionId: string;
      by: "human" | "timeout";
      ts: string;
    }
  | { kind: "interrupt"; from: AgentId; target: AgentId; reason?: string; ts: string }
  | { kind: "log"; text: string; ts: string };

export function now(): string {
  return new Date().toISOString();
}
