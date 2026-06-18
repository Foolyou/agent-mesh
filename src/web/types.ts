// Shared types for the WebUI: aggregated transcript items, gateway state, and the
// WebSocket wire protocol. These are the contract between WebGateway (server) and
// the client store.
import type { AgentConfig, MeshConfig, AgentId, AgentStatus, AgentActivity, AgentRole, HarnessId, SessionMode, SessionModel, SessionEffort, PromptImageRef, ThinkingEffort, MeshEdge, AgentTurnSource, AgentHealthSignalKind, AgentTurn } from "../acp/types";
import type { MutationAckStatus } from "../protocol";
export type { MutationAckStatus };
import type { BoardDocument } from "../board";
export type { BoardDocument };
export type { SessionMode };
export type { SessionModel };
export type { PromptImageRef };
export type { ThinkingEffort };
export type { AgentConfig };
export type StartSessionStrategy = "resume" | "fresh";

/** Outcome of a config mutation (setMode/setModel/setEffort), the shared client/server
 *  contract for distinguishing "desired persisted" from "live apply succeeded/failed".
 *  - saved:    desired value persisted to disk (replays on next start).
 *  - applied:  the live mutation reached a running daemon and was acked.
 *  - ackStatus: strongest applied guarantee, present only when applied.
 *  - error:    present only when a live apply was attempted and failed (desired may still be saved). */
export interface MutationApplyResult {
  saved: boolean;
  applied: boolean;
  ackStatus?: MutationAckStatus;
  error?: string;
}

/** The session modes an agent advertises plus which one is active. */
export interface AgentModes {
  current: string;
  available: SessionMode[];
}

export interface AgentModels {
  current: string;
  available: SessionModel[];
}

export interface AgentEfforts {
  configId: string;
  current: string;
  available: SessionEffort[];
}

export interface AgentCapabilities {
  image: boolean;
}

export interface AgentUsage {
  used?: number;
  size?: number;
  cost?: number;
  ts: string;
}

export interface AgentSelfAwareness {
  silentTaskCompletes?: { count: number; lastAt: number | null };
  nearLimit?: { usagePercent: number; ts: number };
  lastCompactAt?: number | null;
  lastNearLimitWarnedAt?: number | null;
}

export interface AgentHealthSignalEntry {
  signal: AgentHealthSignalKind;
  detail?: Record<string, unknown>;
  turn?: AgentTurn;
  ts: string;
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
  | { id: string; kind: "message"; role: "user" | "agent"; text: string; messageId?: string; ts: string; complete: boolean; images?: PromptImageRef[] }
  | { id: string; kind: "thought"; text: string; messageId?: string; ts: string; complete: boolean }
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
  | { id: string; kind: "mail"; from: AgentId; to: AgentId; body: string; ts: string }
  | { id: string; kind: "attachment"; agent: AgentId; path: string; caption?: string; name?: string; contentType: string; ts: string }
  | { id: string; kind: "compact"; status: "started" | "completed" | "failed"; reason?: string; error?: string; ts: string }
  | { id: string; kind: "divider"; label: string; ts: string };

export type TranscriptOp =
  | { op: "upsert"; item: TranscriptItem }
  | { op: "patch"; id: string; patch: Partial<TranscriptItem> };

export interface TranscriptSnapshot {
  items: TranscriptItem[];
  hasMore: boolean;
  oldestSeq?: string;
}

// ── Gateway state + WebSocket wire protocol ──────────────────────────────────
export type MeshStatus = "stopped" | "starting" | "running" | "dead";

/** Identifies which conversation transcript an op belongs to. Router chat is just
 *  the router agent's transcript. */
export type ConvRef = { scope: "assistant" } | { scope: "agent"; mesh: string; agent: AgentId };

export interface MeshSummary {
  name: string;
  defined: boolean;
  status: MeshStatus;
  router: AgentId;
  agents: { id: AgentId; harness: HarnessId; role: AgentRole; status: AgentStatus; activity: AgentActivity; effort?: ThinkingEffort; opencodePermission?: "allow" | "ask"; lazy?: boolean; model?: AgentModels }[];
  /** Directed mail edges; lets the topology render from the summary alone. */
  edges: MeshEdge[];
}

export type HarnessAuthState = "ok" | "required" | "unknown";
export type HarnessInstallable = "npm" | "self" | "manual";
export interface HarnessProbeRow {
  id: HarnessId;
  label: string;
  installed: boolean;
  version?: string;
  path?: string;
  latest?: string;
  outdated?: boolean;
  auth: HarnessAuthState;
  installable: HarnessInstallable;
  installSpec?: { npmPackage: string; pinnedVersion: string; bin: string };
  installHint?: { command: string; docsUrl: string };
  lastProbeAt: number;
  error?: string;
  runningAgentsUsingOldVersion: string[];
}

export interface HarnessInstallEvent {
  step: "started" | "fetch" | "install" | "link" | "done" | "error";
  harnessId: HarnessId;
  pkgSpec: string;
  progress?: number;
  stdoutLine?: string;
  stderrLine?: string;
  installedVersion?: string;
  installedPath?: string;
  code?: number;
  message?: string;
}

export type RespawnMode = "after-idle" | "force" | "cancel";

export interface ActivityEntry {
  id: string;
  ts: string;
  kind: "mail" | "steer" | "interrupt" | "permission_resolved" | "log" | "compact" | "warning";
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

export interface QueueSummary {
  count: number;
  latestId?: string;
  latestPreview?: string;
  items?: QueueItem[];
}

export interface QueueItem {
  id: string;
  source: AgentTurnSource;
  preview: string;
  ts: string;
  from?: AgentId | "operator";
  to?: AgentId;
}

export interface PerMeshState {
  config: MeshConfig;
  transcripts: Record<AgentId, TranscriptSnapshot>;
  activity: ActivityEntry[];
  mail: MailEntry[];
  pending: PermissionReq[];
  history: ResolvedPermission[];
  /** Per-agent session modes (advertised + active), populated while the mesh runs. */
  modes: Record<AgentId, AgentModes>;
  /** Per-agent model choices (advertised + active), populated while the mesh runs. */
  models: Record<AgentId, AgentModels>;
  /** Per-agent runtime effort choices (advertised + active), populated while the mesh runs. */
  efforts: Record<AgentId, AgentEfforts>;
  /** Per-agent prompt capabilities, populated while the mesh runs. */
  capabilities: Record<AgentId, AgentCapabilities>;
  /** Per-agent context/cost waterline folded from usage_update notifications. */
  usage: Record<AgentId, AgentUsage>;
  /** Latest per-agent silence/health signal for UI status surfaces. */
  health: Record<AgentId, AgentHealthSignalEntry>;
  /** Per-agent mesh-host self-awareness diagnostics. */
  selfAwareness: Record<AgentId, AgentSelfAwareness>;
  queues: Record<AgentId, QueueSummary>;
  /** The full collaboration board, folded from board_snapshot events. Null until the first
   *  snapshot arrives (e.g. a stopped mesh with no running daemon). */
  board: BoardDocument | null;
}

export type AssistantStatus = "absent" | "starting" | "ready" | "stopped";

export interface GatewayState {
  appVersion?: string;
  meshes: MeshSummary[];
  assistant: { status: AssistantStatus; working?: boolean; transcript: TranscriptItem[]; capabilities?: AgentCapabilities & { harness?: HarnessId } };
  perMesh: Record<string, PerMeshState>;
}

export type ServerMsg =
  | { t: "snapshot"; state: GatewayState }
  | { t: "mesh.list"; meshes: MeshSummary[] }
  | { t: "mesh.status"; name: string; status: MeshStatus }
  | { t: "agent.status"; name: string; agent: AgentId; status: AgentStatus; detail?: string }
  | { t: "agent.activity"; name: string; agent: AgentId; activity: AgentActivity }
  | { t: "agent.modes"; name: string; agent: AgentId; current: string; available: SessionMode[] }
  | { t: "agent.models"; name: string; agent: AgentId; current: string; available: SessionModel[] }
  | { t: "agent.efforts"; name: string; agent: AgentId; configId: string; current: string; available: SessionEffort[] }
  | { t: "agent.capabilities"; name: string; agent: AgentId; image: boolean }
  | { t: "agent.usage"; name: string; agent: AgentId; usage: AgentUsage }
  | { t: "agent.health"; name: string; agent: AgentId; health: AgentHealthSignalEntry }
  | { t: "agent.selfAwareness"; name: string; agent: AgentId; selfAwareness: AgentSelfAwareness }
  | { t: "agent.queue"; name: string; agent: AgentId; summary: QueueSummary }
  | { t: "assistant.capabilities"; image: boolean; harness?: HarnessId }
  | { t: "transcript.upsert"; conv: ConvRef; item: TranscriptItem }
  | { t: "transcript.patch"; conv: ConvRef; id: string; patch: Partial<TranscriptItem> }
  | { t: "activity"; name: string; entry: ActivityEntry }
  | { t: "mail"; name: string; entry: MailEntry }
  | { t: "board"; name: string; board: BoardDocument }
  | { t: "permission.add"; name: string; req: PermissionReq }
  | { t: "permission.remove"; name: string; resolved: ResolvedPermission }
  | { t: "assistant.status"; status: AssistantStatus; working?: boolean }
  | { t: "harnesses-changed"; harnessId: HarnessId };

export type { MeshConfig, MeshEdge, AgentId, AgentStatus, AgentActivity, AgentRole, HarnessId };
