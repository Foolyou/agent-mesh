// Shared types for the WebUI: aggregated transcript items, gateway state, and the
// WebSocket wire protocol. These are the contract between WebGateway (server) and
// the client store.
import type { MeshConfig, AgentId, AgentStatus, AgentRole, HarnessId, SessionMode, PromptImageRef, ThinkingEffort } from "../acp/types";
export type { SessionMode };
export type { PromptImageRef };
export type { ThinkingEffort };

/** The session modes an agent advertises plus which one is active. */
export interface AgentModes {
  current: string;
  available: SessionMode[];
}

export interface AgentCapabilities {
  image: boolean;
}

// ── Aggregated transcript ────────────────────────────────────────────────────
// A transcript folds the raw ACP SessionUpdate stream into ordered, identity-keyed
// items so the UI renders coherent message bubbles / tool-call cards instead of one
// line per raw event.

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PlanEntry {
  content: string;
  status: string; // "pending" | "in_progress" | "completed"
  priority?: string;
}

export type TranscriptItem =
  | { id: string; kind: "message"; role: "user" | "agent"; text: string; ts: string; complete: boolean; images?: PromptImageRef[] }
  | { id: string; kind: "thought"; text: string; ts: string; complete: boolean }
  | {
      id: string;
      kind: "tool_call";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: ToolCallStatus;
      input?: string;
      output?: string;
      locations?: string[];
      ts: string;
      updatedTs: string;
    }
  | { id: string; kind: "plan"; entries: PlanEntry[]; ts: string; updatedTs: string }
  | { id: string; kind: "mail"; from: AgentId; to: AgentId; body: string; ts: string };

export type TranscriptOp =
  | { op: "upsert"; item: TranscriptItem }
  | { op: "patch"; id: string; patch: Partial<TranscriptItem> };

// ── Gateway state + WebSocket wire protocol ──────────────────────────────────
export type MeshStatus = "stopped" | "starting" | "running" | "dead";

/** Identifies which conversation transcript an op belongs to. Router chat is just
 *  the router agent's transcript. */
export type ConvRef = { scope: "master" } | { scope: "agent"; mesh: string; agent: AgentId };

export interface MeshSummary {
  name: string;
  defined: boolean;
  status: MeshStatus;
  router: AgentId;
  agents: { id: AgentId; harness: HarnessId; role: AgentRole; status: AgentStatus; effort?: ThinkingEffort }[];
  /** Directed mail edges [from, to]; lets the topology render from the summary alone. */
  edges: [AgentId, AgentId][];
}

export interface ActivityEntry {
  id: string;
  ts: string;
  kind: "mail" | "interrupt" | "permission_resolved" | "log";
  text: string;
}

export interface PermissionReq {
  requestId: string;
  agent: AgentId;
  question: string;
  options: { id: string; name: string; kind?: string }[];
  ts: string;
}

export interface ResolvedPermission {
  requestId: string;
  agent: AgentId;
  optionId: string;
  by: "human" | "timeout";
  ts: string;
}

export interface MailEntry {
  id: string;
  ts: string;
  from: AgentId;
  to: AgentId;
  body: string;
}

export interface PerMeshState {
  config: MeshConfig;
  transcripts: Record<AgentId, TranscriptItem[]>;
  activity: ActivityEntry[];
  mail: MailEntry[];
  pending: PermissionReq[];
  history: ResolvedPermission[];
  /** Per-agent session modes (advertised + active), populated while the mesh runs. */
  modes: Record<AgentId, AgentModes>;
  /** Per-agent prompt capabilities, populated while the mesh runs. */
  capabilities: Record<AgentId, AgentCapabilities>;
}

export type MasterStatus = "absent" | "starting" | "ready" | "stopped";

export interface GatewayState {
  meshes: MeshSummary[];
  master: { status: MasterStatus; transcript: TranscriptItem[]; capabilities?: AgentCapabilities };
  perMesh: Record<string, PerMeshState>;
}

export type ServerMsg =
  | { t: "snapshot"; state: GatewayState }
  | { t: "mesh.list"; meshes: MeshSummary[] }
  | { t: "mesh.status"; name: string; status: MeshStatus }
  | { t: "agent.status"; name: string; agent: AgentId; status: AgentStatus; detail?: string }
  | { t: "agent.modes"; name: string; agent: AgentId; current: string; available: SessionMode[] }
  | { t: "agent.capabilities"; name: string; agent: AgentId; image: boolean }
  | { t: "master.capabilities"; image: boolean }
  | { t: "transcript.upsert"; conv: ConvRef; item: TranscriptItem }
  | { t: "transcript.patch"; conv: ConvRef; id: string; patch: Partial<TranscriptItem> }
  | { t: "activity"; name: string; entry: ActivityEntry }
  | { t: "mail"; name: string; entry: MailEntry }
  | { t: "permission.add"; name: string; req: PermissionReq }
  | { t: "permission.remove"; name: string; resolved: ResolvedPermission }
  | { t: "master.status"; status: MasterStatus };

export type { MeshConfig, AgentId, AgentStatus, AgentRole, HarnessId };
