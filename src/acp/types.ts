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

/** Reasoning / thinking effort for an agent — the global union of effort levels across
 *  harnesses. Legal values are constrained PER HARNESS by HARNESS_EFFORT_CAPABILITIES
 *  (e.g. Claude = low|medium|high|xhigh|max; codex = low|medium|high|xhigh). `minimal` is
 *  retained for back-compat with older persisted configs but is no longer offered by any
 *  harness. Some harnesses apply effort at spawn (codex: model_reasoning_effort) and some
 *  switch it at runtime via ACP config options. `undefined` = harness default. */
export type ThinkingEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  /** opencode-only permission policy applied at spawn (opencode exposes no ACP permission
   *  mode, only the OPENCODE_PERMISSION env). "allow" grants autonomous tool use; "ask"
   *  (or undefined) defers to opencode's own default. Other harnesses express permission
   *  through `mode` instead (codex full-access, claude bypassPermissions, kimi yolo). */
  opencodePermission?: "allow" | "ask";
  /** Runtime-selected session mode cache. Applied best-effort after spawn when advertised.
   *  Also where permission level lives for mode-based harnesses (codex/claude/kimi). */
  mode?: string;
  /** Runtime-selected model cache. Applied best-effort after spawn when advertised. */
  model?: string;
  /** Optional per-agent instructions injected into THIS agent's briefing only. Free text. */
  instructions?: string;
}

export interface AutoCompactSettings {
  enabled: boolean;
  threshold: string;
}

export interface MeshConfig {
  name: string;
  agents: AgentConfig[];
  /** Directed mail edges; steer=true grants interrupting priority delivery for that edge. */
  edges: MeshEdge[];
  /** Optional team charter — shared goal + working norms injected into every
   *  agent's mesh briefing. Free text. */
  charter?: string;
  /** Optional per-mesh automatic context compaction settings. Missing means
   *  DEFAULT_AUTO_COMPACT_SETTINGS ({ enabled: true, threshold: "85%" }). */
  autoCompact?: AutoCompactSettings;
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

export interface SessionEffort {
  id: string;
  name: string;
  description?: string;
}

export interface PromptImageRef {
  id: string;
  mimeType: string;
  name: string;
  url?: string;
  bucket?: string;
  path?: string;
}

export type AgentTurnSource = "operator" | "mail" | "steer" | "system";

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
  | { kind: "agent_efforts"; agent: AgentId; configId: string; current: string; available: SessionEffort[]; ts: string }
  | { kind: "agent_capabilities"; agent: AgentId; image: boolean; ts: string }
  | { kind: "agent_resolved_harness"; agent: AgentId; harness: HarnessId; path?: string; version?: string; spawnedAt: string; ts: string }
  | { kind: "agent_turn"; phase: "queued" | "started" | "consumed" | "removed"; turn: AgentTurn; ts: string }
  | { kind: "agent_turn_health"; agent: AgentId; turn?: AgentTurn; level: "warning" | "failed"; reason: TurnHealthReason; detail: string; ts: string }
  | { kind: "agent_health_signal"; agent: AgentId; signal: AgentHealthSignalKind; detail?: Record<string, unknown>; turn?: AgentTurn; ts: string }
  | { kind: "silent_task_complete"; agent: AgentId; turnId: string; ts: number }
  | { kind: "bare_prompt"; agent: AgentId; reason: string; ts: number }
  | { kind: "compact_started"; agent: AgentId; reason: string; ts: number }
  | { kind: "compact_completed"; agent: AgentId; ts: number }
  | { kind: "compact_failed"; agent: AgentId; error: string; ts: number }
  | { kind: "near_context_limit_no_compact"; agent: AgentId; usagePercent: number; ts: number }
  // Per-agent context usage AFTER the control-plane normalizes the denominator against the
  // Zed-style model→window table (see resolveContextWindow). `size` is the authoritative
  // window, not the harness's possibly-too-small reported size; `percent` is used/size.
  // The control-plane is the single normalization point — the web consumes this instead of
  // recomputing from raw usage_update frames. Replayed by snapshotEvents() on reattach.
  | { kind: "agent_usage"; agent: AgentId; used: number; size: number; percent: number; cost?: number; ts: string }
  // Brackets a loadSession() history replay: the harness re-emits the whole session as a
  // flood of session/update events. The gateway folds them into state but suppresses the
  // per-item broadcast so reattached WS clients learn the result from the snapshot instead
  // of a one-by-one upsert storm. Pairing is replay-safe: the ring buffer evicts oldest
  // first, so a replayed "started" always carries its later "finished".
  | { kind: "replay_started"; agent: AgentId; ts: string }
  | { kind: "replay_finished"; agent: AgentId; ts: string }
  | { kind: "mail"; from: AgentId; to: AgentId; body: string; ts: string; id?: string }
  // An agent published one of its own artifact files as a first-class attachment card.
  // owner is ALWAYS the publishing agent (control-plane derives it from the caller's
  // identity; it is never taken from tool input). Held in control-plane state and
  // replayed via snapshotEvents() so a backend reattach rebuilds it without the ring.
  | { kind: "attachment_published"; agent: AgentId; path: string; caption?: string; name?: string; contentType: string; ts: string }
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
