// Core domain types for the Agent Mesh control plane.
// Re-export the ACP schema/classes under `schema` for convenient access.
export * as schema from "@zed-industries/agent-client-protocol";

export type HarnessId = "codex" | "opencode" | "claude" | "kimi";
export type AgentRole = "router" | "member";

/** Unique within a mesh, e.g. "codex-1". */
export type AgentId = string;

/** Reasoning / thinking effort for an agent. Applied at spawn (codex: model_reasoning_effort;
 *  claude: MAX_THINKING_TOKENS). `undefined` = the harness's own default. */
export type ThinkingEffort = "minimal" | "low" | "medium" | "high";

export interface AgentConfig {
  id: AgentId;
  harness: HarnessId;
  /** Working directory (the "Project" layer), relative to repo root. */
  project: string;
  role: AgentRole;
  /** Optional reasoning/thinking effort; applied when the agent process (re)starts. */
  effort?: ThinkingEffort;
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
  /** Directed edges: [from, to] means `from` may send mail to `to`. */
  edges: Array<[AgentId, AgentId]>;
  /** Optional team charter — shared goal + working norms injected into every
   *  agent's mesh briefing. Free text. */
  charter?: string;
}

export type AgentStatus = "spawning" | "ready" | "dead";
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

export type MeshEvent =
  | { kind: "agent_status"; agent: AgentId; status: AgentStatus; detail?: string; ts: string }
  | { kind: "agent_activity"; agent: AgentId; activity: AgentActivity; ts: string }
  | { kind: "update"; agent: AgentId; update: unknown; ts: string }
  | { kind: "agent_modes"; agent: AgentId; current: string; available: SessionMode[]; ts: string }
  | { kind: "agent_models"; agent: AgentId; current: string; available: SessionModel[]; ts: string }
  | { kind: "agent_capabilities"; agent: AgentId; image: boolean; ts: string }
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
