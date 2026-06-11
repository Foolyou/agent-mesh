// Core domain types for the Agent Mesh control plane.
// Re-export the ACP schema/classes under `schema` for convenient access.
export * as schema from "@zed-industries/agent-client-protocol";

export type HarnessId = "codex" | "opencode" | "claude" | "kimi";
export type AgentRole = "router" | "member";

/** Unique within a mesh, e.g. "codex-1". */
export type AgentId = string;

export interface MeshEdge {
  from: AgentId;
  to: AgentId;
  steer?: boolean;
}

export type MeshEdgeInput = MeshEdge | [AgentId, AgentId];

export function normalizeMeshEdge(edge: MeshEdgeInput): MeshEdge {
  if (Array.isArray(edge)) {
    return { from: edge[0], to: edge[1], steer: false };
  }
  return { from: edge.from, to: edge.to, steer: edge.steer === true };
}

export function normalizeMeshEdges(edges: readonly MeshEdgeInput[] = []): MeshEdge[] {
  return edges.map((edge) => normalizeMeshEdge(edge));
}

/** Reasoning / thinking effort for an agent. Some harnesses apply it at spawn
 *  (codex: model_reasoning_effort; claude: MAX_THINKING_TOKENS) and some can
 *  switch compatible runtime thought-level config options. `undefined` = default. */
export type ThinkingEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentConfig {
  id: AgentId;
  harness: HarnessId;
  /** Working directory (the "Project" layer), relative to repo root. */
  project: string;
  role: AgentRole;
  /** If true, the agent starts cold and is spawned on first mail or manual wake. Routers may not be lazy. */
  lazy?: boolean;
  /** Optional reasoning/thinking effort; runtime-switched when supported, otherwise applied on restart. */
  effort?: ThinkingEffort;
  /** Permission bypass request. Claude/OpenCode apply this at spawn; Codex maps it to full-access mode. Kimi does not support it. */
  bypass?: boolean;
  /** Runtime-selected session mode cache. Applied best-effort after spawn when advertised. */
  mode?: string;
  /** Runtime-selected model cache. Applied best-effort after spawn when advertised. */
  model?: string;
  /** Optional per-agent instructions injected into THIS agent's briefing only. Free text. */
  instructions?: string;
}

export interface MeshConfig {
  name: string;
  agents: AgentConfig[];
  /** Directed mail edges; steer=true grants interrupting priority delivery for that edge. */
  edges: MeshEdge[];
  /** Optional team charter — shared goal + working norms injected into every
   *  agent's mesh briefing. Free text. */
  charter?: string;
}

export type AgentStatus = "cold" | "spawning" | "ready" | "dead" | "stopped";
export type AgentActivity = "idle" | "working";

/** An ACP session operating mode the agent advertises (e.g. codex read-only / full-access,
 *  claude default / plan / acceptEdits). The operator can switch between the advertised modes. */
export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModel {
  id: string;
  name: string;
}

export interface PromptImageRef {
  id: string;
  mimeType: string;
  name: string;
  url?: string;
  bucket?: string;
  path?: string;
}

export type AgentTurnSource = "operator" | "mail" | "steer";

export interface AgentTurn {
  id: string;
  agent: AgentId;
  source: AgentTurnSource;
  text: string;
  preview: string;
  ts: string;
  images?: PromptImageRef[];
  from?: AgentId | "operator";
  to?: AgentId;
  /** Durable mailbox event id for mail-wake turns; lets check_mail cancel the
   *  still-queued wake once the mail has been read inside another turn. */
  mailId?: string;
  /** Human-facing durable mail number used in mesh mail headers. */
  mailSeq?: number;
}

export type TurnHealthReason = "first_signal_timeout" | "idle_stall_timeout" | "wake_failed" | "cancel_failed";

export type AgentHealthSignalKind = "rate_limited" | "retrying" | "compacting" | "compact_done";

export type MeshEvent =
  | { kind: "agent_status"; agent: AgentId; status: AgentStatus; detail?: string; ts: string }
  | { kind: "agent_activity"; agent: AgentId; activity: AgentActivity; ts: string }
  | { kind: "update"; agent: AgentId; update: unknown; ts: string }
  | { kind: "agent_modes"; agent: AgentId; current: string; available: SessionMode[]; ts: string }
  | { kind: "agent_models"; agent: AgentId; current: string; available: SessionModel[]; ts: string }
  | { kind: "agent_capabilities"; agent: AgentId; image: boolean; ts: string }
  | { kind: "agent_turn"; phase: "queued" | "started" | "consumed" | "removed"; turn: AgentTurn; ts: string }
  | { kind: "agent_turn_health"; agent: AgentId; turn?: AgentTurn; level: "warning" | "failed"; reason: TurnHealthReason; detail: string; ts: string }
  | { kind: "agent_health_signal"; agent: AgentId; signal: AgentHealthSignalKind; detail?: Record<string, unknown>; turn?: AgentTurn; ts: string }
  | { kind: "mail"; from: AgentId; to: AgentId; body: string; ts: string; id?: string }
  | { kind: "steer"; from: AgentId | "operator"; to: AgentId; body: string; ts: string }
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
