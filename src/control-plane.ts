// ControlPlane: the single global control plane. Sole ACP client (holds one
// AcpAgentConnection per agent), runs the Mesh Services MCP server, owns the
// mailbox + event bus, and arbitrates permission escalations.
import { join, resolve } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AcpAgentConnection, type AcpConnectionOptions, type PermissionDecision } from "./acp/client";
import { spawnConfigFor } from "./harness";
import { isThinkingEffort, runtimeEffortConfig, runtimeEffortOptionsFromSession, type RuntimeEffortOptions } from "./harness-utils";
import { Mesh } from "./mesh";
import { buildMeshBriefing, MAIL_WAKE_GUIDANCE } from "./mesh-briefing";
import { createMeshServicesServer, type MeshServicesHandlers, type MeshServicesServer, type MeshToolContext, type SendMailOptions } from "./mcp/mesh-services";
import { compactMailbox, sendMail, readMailFor, readMailboxEvents, readRecentAddressedMail, readUnreadAddressedMail, type MailMeta } from "./mailbox";
import { validateAddAgent, validateAddEdge } from "./mesh-validate";
import { artifactAgentDir } from "./web/artifacts";
import { readSessionState, setMeshExpectedAlive, updateAgentMailCursor, updateAgentSession, clearAgentSession, type MeshSessionState } from "./session-storage";
import { now, type AgentActivity, type AgentConfig, type AgentHealthSignalKind, type AgentId, type AgentTurn, type MeshConfig, type MeshEdge, type MeshEvent, type PromptImageRef, type SessionMode, type SessionModel, type ThinkingEffort, type TurnHealthReason } from "./acp/types";

interface PendingDecision {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Rendering metadata for one mail delivery: short number, reply reference, task thread. */
interface MailDeliveryMeta {
  seq?: number;
  replyTo?: number;
  task?: string;
}

interface ActiveTurnHealth {
  agent: AgentId;
  turn: AgentTurn;
  conn: AcpAgentConnection;
  startedAt: string;
  firstSignalAt?: string;
  lastSignalAt?: string;
  /** Fires when a started turn has stayed completely silent; surfaces a non-fatal
   *  "agent is quiet" warning. Never cancels or kills — recovery is manual. */
  quietWarnTimer?: ReturnType<typeof setTimeout>;
  /** How many quiet warnings have been surfaced for this turn (drives backoff). */
  quietWarnCount?: number;
}

interface HealthFailureSummary {
  reason: TurnHealthReason;
  detail: string;
  ts: string;
}

function compactPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function turnPreview(label: string, text: string, images: PromptImageRef[] = []): string {
  const preview = compactPreview(text);
  return `${label}: ${preview || (images.length ? "[image]" : "")}`;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function publicImageRef(i: PromptImageRef): PromptImageRef {
  return { id: i.id, mimeType: i.mimeType, name: i.name, url: i.url };
}

function claudeHealthSignal(message: unknown): { signal: AgentHealthSignalKind; detail?: Record<string, unknown> } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as any;
  if (m.type === "system" && m.subtype === "api_retry") {
    return {
      signal: "retrying",
      detail: {
        attempt: m.attempt,
        maxRetries: m.max_retries ?? m.maxRetries,
        retryDelayMs: m.retry_delay_ms ?? m.retryDelayMs,
        reason: m.error,
      },
    };
  }
  if (m.type === "rate_limit_event") {
    const info = m.rate_limit_info ?? m.rateLimitInfo ?? {};
    const status = info.status;
    if (status !== "allowed_warning" && status !== "warning" && status !== "rejected") return undefined;
    return {
      signal: "rate_limited",
      detail: {
        status,
        resetsAt: info.resetsAt,
        rateLimitType: info.rateLimitType,
        utilization: info.utilization,
      },
    };
  }
  if (m.type === "system" && m.subtype === "status" && (m.status === "compacting" || m.state === "compacting")) {
    return { signal: "compacting", detail: { status: m.status ?? m.state } };
  }
  if (m.type === "system" && m.subtype === "status" && m.status === null && m.compact_result) {
    const result = String(m.compact_result);
    return {
      signal: "compact_done",
      detail: { outcome: result },
    };
  }
  if (m.type === "system" && m.subtype === "compact_boundary") {
    const meta = m.compact_metadata ?? m.compactMetadata ?? {};
    return {
      signal: "compact_done",
      detail: {
        trigger: meta.trigger,
        preTokens: meta.pre_tokens ?? meta.preTokens,
        postTokens: meta.post_tokens ?? meta.postTokens,
        durationMs: meta.duration_ms ?? meta.durationMs,
      },
    };
  }
  return undefined;
}

export type ControlPlaneStopReason = "explicit" | "idle" | "shutdown";

export interface ResolvedHarnessInfo {
  agentId: AgentId;
  harnessId: AgentConfig["harness"];
  path?: string;
  version?: string;
  spawnedAt: string;
}

export type RespawnMode = "after-idle" | "force" | "cancel";
export interface RespawnResult {
  mode: RespawnMode;
  scheduled: boolean;
  willRunWhen?: "idle" | "now";
  note?: string;
}

export interface ControlPlaneOptions {
  mailboxPath?: string;
  /** auto-deny a permission request after this many ms with no human decision */
  permissionTimeoutMs?: number;
  debug?: boolean;
  uploadRoot?: string;
  artifactsRoot?: string;
  /** ${root}/run directory for durable per-mesh ACP session identity. */
  sessionRunDir?: string;
  connectionFactory?: (opts: AcpConnectionOptions) => AcpAgentConnection;
  /** test seam: override how the injected mesh-services MCP server is built */
  meshServicesFactory?: (handlers: MeshServicesHandlers) => MeshServicesServer;
  /** lazy agent spawn must either finish or fail within this window */
  spawnTimeoutMs?: number;
  mailboxCompactThresholdEvents?: number;
  mailboxCompactThresholdBytes?: number;
  mailboxArchiveMaxEvents?: number;
  /** Max mails returned per check_mail call (cursor only advances past returned mail). */
  checkMailMaxCount?: number;
  /** Max total body bytes per check_mail call; at least one mail is always returned. */
  checkMailMaxBytes?: number;
  /** A started prompt that emits no signal within this long surfaces a non-fatal
   *  "agent is quiet" warning. It NEVER cancels or kills the turn — a silent codex
   *  is usually just doing long reasoning/compaction on a large context, and recovery
   *  from a genuine hang is left to the operator. 0 disables the warning. */
  turnFirstSignalTimeoutMs?: number;
  /** Reserved for future idle-stall enforcement. 0 disables enforcement. */
  turnIdleStallTimeoutMs?: number;
}

export class ControlPlane {
  readonly mesh: Mesh;
  private conns = new Map<AgentId, AcpAgentConnection>();
  private listeners = new Set<(e: MeshEvent) => void>();
  private mcp?: MeshServicesServer;
  private mailboxPath: string;
  private mailCursors = new Map<AgentId, string | undefined>();
  private pending = new Map<string, PendingDecision>();
  private permissionTimeoutMs: number;
  private debug: boolean;
  private uploadRoot?: string;
  private artifactsRoot?: string;
  private sessionRunDir?: string;
  private connectionFactory: (opts: AcpConnectionOptions) => AcpAgentConnection;
  private meshServicesFactory: (handlers: MeshServicesHandlers) => MeshServicesServer;
  private spawnTimeoutMs: number;
  private mailboxCompactThresholdEvents: number;
  private mailboxCompactThresholdBytes: number;
  private mailboxArchiveMaxEvents: number;
  private checkMailMaxCount: number;
  private checkMailMaxBytes: number;
  private turnFirstSignalTimeoutMs: number;
  private turnIdleStallTimeoutMs: number;
  private spawning = new Map<AgentId, Promise<AcpAgentConnection>>();
  private spawnFails = new Map<AgentId, number>();
  private spawnGeneration = new Map<AgentId, number>();
  private dynamicEdges = new Set<string>();
  /** Per-agent advertised image-input capability (promptCapabilities.image). */
  private imageCaps = new Map<AgentId, boolean>();
  /** Per-agent advertised permission/session modes. */
  private sessionModes = new Map<AgentId, { current: string; available: SessionMode[] }>();
  /** Per-agent advertised model choices. */
  private sessionModels = new Map<AgentId, { current: string; available: SessionModel[] }>();
  /** Per-agent advertised runtime thinking effort choices. */
  private sessionEfforts = new Map<AgentId, RuntimeEffortOptions>();
  /** Agents that have already received the one-time mesh briefing. */
  private briefed = new Set<AgentId>();
  /** Agents whose current process was attached to a loaded ACP session. */
  private loadedSessions = new Set<AgentId>();
  /** Loaded sessions whose first prompt has not yet succeeded. */
  private resumePendingValidation = new Set<AgentId>();
  /** Per-agent in-flight prompt turns. count > 0 means working unless the agent is dead. */
  private turnCounts = new Map<AgentId, number>();
  private queuedTurns = new Map<AgentId, AgentTurn[]>();
  private startedTurnIds = new Set<string>();
  private activeTurnHealth = new Map<AgentId, ActiveTurnHealth>();
  private lastHealthFailure = new Map<AgentId, HealthFailureSummary>();
  /** Mail ids each agent has already read via check_mail; a late wake for one of
   *  these is dropped instead of queueing a duplicate prompt turn. */
  private consumedMailIds = new Map<AgentId, Set<string>>();
  /** Recent durable mail, replayed via snapshotEvents() so reconnecting clients
   *  see mail history instead of only live deliveries. */
  private recentMail: { id: string; from: AgentId; to: AgentId; body: string; ts: string }[] = [];
  /** Per-mesh monotonic short mail number; recovered from the mailbox on start. */
  private mailSeq = 0;
  /** seq → mail summary, for rendering "in reply to #N" quotes. Bounded. */
  private mailBySeq = new Map<number, { from: string; to: string; body: string }>();
  /** Consecutive empty check_mail calls per agent, to nudge pollers. */
  private emptyMailChecks = new Map<AgentId, { count: number; last: number }>();
  private activityStates = new Map<AgentId, AgentActivity>();
  private sessionState: MeshSessionState = { meshExpectedAlive: true, agents: {} };
  private resolvedHarnesses = new Map<AgentId, ResolvedHarnessInfo>();
  private pendingRespawns = new Map<AgentId, ReturnType<typeof setTimeout>>();

  constructor(config: MeshConfig, opts: ControlPlaneOptions = {}) {
    this.mesh = new Mesh(config);
    this.mailboxPath = opts.mailboxPath ?? resolve(process.cwd(), ".mesh", `${config.name}-mailbox.ndjson`);
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? 60_000;
    this.debug = opts.debug ?? false;
    this.uploadRoot = opts.uploadRoot;
    this.artifactsRoot = opts.artifactsRoot;
    this.sessionRunDir = opts.sessionRunDir;
    this.connectionFactory = opts.connectionFactory ?? ((connOpts) => new AcpAgentConnection(connOpts));
    this.meshServicesFactory = opts.meshServicesFactory ?? ((handlers) => createMeshServicesServer({ handlers }));
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? 60_000;
    this.mailboxCompactThresholdEvents = opts.mailboxCompactThresholdEvents ?? 1_000;
    this.mailboxCompactThresholdBytes = opts.mailboxCompactThresholdBytes ?? 1_000_000;
    this.mailboxArchiveMaxEvents = opts.mailboxArchiveMaxEvents ?? 2_000;
    this.checkMailMaxCount = opts.checkMailMaxCount ?? 20;
    this.checkMailMaxBytes = opts.checkMailMaxBytes ?? 64_000;
    this.turnFirstSignalTimeoutMs = opts.turnFirstSignalTimeoutMs ?? numberEnv("MESH_TURN_FIRST_SIGNAL_MS", 120_000);
    this.turnIdleStallTimeoutMs = opts.turnIdleStallTimeoutMs ?? numberEnv("MESH_TURN_IDLE_STALL_MS", 0);
  }

  // ---- event bus ----
  on(listener: (e: MeshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(e: MeshEvent): void {
    for (const l of this.listeners) l(e);
  }
  private log(text: string): void {
    this.emit({ kind: "log", text, ts: now() });
  }

  agent(id: AgentId): AcpAgentConnection {
    const c = this.conns.get(id);
    if (!c) throw new Error(`no connection for agent ${id}`);
    return c;
  }

  getResolvedHarness(id: AgentId): ResolvedHarnessInfo | undefined {
    const info = this.resolvedHarnesses.get(id);
    return info ? { ...info } : undefined;
  }

  listResolvedHarnesses(): ResolvedHarnessInfo[] {
    return [...this.resolvedHarnesses.values()].map((info) => ({ ...info }));
  }

  /** Current authoritative agent state for reconnecting clients. */
  snapshotEvents(): MeshEvent[] {
    const ts = now();
    const events: MeshEvent[] = [];
    for (const a of this.mesh.agents) {
      events.push({ kind: "agent_status", agent: a.id, status: this.mesh.status(a.id) ?? "spawning", ts });
      events.push({ kind: "agent_activity", agent: a.id, activity: this.activityOf(a.id), ts });
      if (this.imageCaps.has(a.id)) {
        events.push({ kind: "agent_capabilities", agent: a.id, image: this.imageCaps.get(a.id)!, ts });
      }
      const resolved = this.resolvedHarnesses.get(a.id);
      if (resolved) {
        events.push({ kind: "agent_resolved_harness", agent: a.id, harness: resolved.harnessId, path: resolved.path, version: resolved.version, spawnedAt: resolved.spawnedAt, ts });
      }
      const modes = this.sessionModes.get(a.id);
      if (modes) {
        events.push({ kind: "agent_modes", agent: a.id, current: modes.current, available: modes.available, ts });
      }
      const models = this.sessionModels.get(a.id);
      if (models) {
        events.push({ kind: "agent_models", agent: a.id, current: models.current, available: models.available, ts });
      }
      for (const turn of this.queuedTurns.get(a.id) ?? []) {
        events.push({ kind: "agent_turn", phase: "queued", turn, ts });
      }
    }
    for (const m of this.recentMail) {
      events.push({ kind: "mail", id: m.id, from: m.from, to: m.to, body: m.body, ts: m.ts });
    }
    return events;
  }

  private pushRecentMail(entry: { id: string; from: AgentId; to: AgentId; body: string; ts: string }): void {
    this.recentMail.push(entry);
    if (this.recentMail.length > 200) this.recentMail.splice(0, this.recentMail.length - 200);
  }

  private noteTurnQueued(turn: AgentTurn): void {
    if (this.startedTurnIds.has(turn.id)) return;
    const q = this.queuedTurns.get(turn.agent) ?? [];
    if (!q.some((queued) => queued.id === turn.id)) q.push(turn);
    this.queuedTurns.set(turn.agent, q);
    this.emit({ kind: "agent_turn", phase: "queued", turn, ts: now() });
  }

  private noteTurnStarted(turn: AgentTurn): void {
    if (this.startedTurnIds.has(turn.id)) {
      this.startTurnHealth(turn);
      return;
    }
    this.startedTurnIds.add(turn.id);
    while (this.startedTurnIds.size > 1000) this.startedTurnIds.delete(this.startedTurnIds.values().next().value!);
    const q = this.queuedTurns.get(turn.agent) ?? [];
    const idx = q.findIndex((queued) => queued.id === turn.id);
    if (idx >= 0) q.splice(idx, 1);
    if (q.length) this.queuedTurns.set(turn.agent, q);
    else this.queuedTurns.delete(turn.agent);
    this.emit({ kind: "agent_turn", phase: "started", turn, ts: now() });
    this.startTurnHealth(turn);
  }

  private clearQueuedTurns(id: AgentId): void {
    this.queuedTurns.delete(id);
  }

  private startTurnHealth(turn: AgentTurn): void {
    const conn = this.conns.get(turn.agent);
    if (!conn || this.turnFirstSignalTimeoutMs <= 0) return;
    this.clearTurnHealth(turn.agent, turn.id);
    const active: ActiveTurnHealth = {
      agent: turn.agent,
      turn,
      conn,
      startedAt: now(),
    };
    active.quietWarnTimer = setTimeout(() => this.handleQuietTurn(active), this.turnFirstSignalTimeoutMs);
    this.activeTurnHealth.set(turn.agent, active);
  }

  private noteTurnSignal(agent: AgentId, turn: AgentTurn | undefined): void {
    const active = this.activeTurnHealth.get(agent);
    if (!active || !turn || active.turn.id !== turn.id) return;
    const ts = now();
    active.firstSignalAt ??= ts;
    active.lastSignalAt = ts;
    // The turn has shown life: stop the quiet-warning watchdog for the rest of it.
    if (active.quietWarnTimer) {
      clearTimeout(active.quietWarnTimer);
      active.quietWarnTimer = undefined;
    }
    // Idle-stall tracking is intentionally data-only in v1.
    void this.turnIdleStallTimeoutMs;
  }

  private finishTurnHealth(agent: AgentId, turn: AgentTurn | undefined): void {
    if (!turn) return;
    this.clearTurnHealth(agent, turn.id);
  }

  private clearTurnHealth(agent: AgentId, turnId?: string): void {
    const active = this.activeTurnHealth.get(agent);
    if (!active || (turnId && active.turn.id !== turnId)) return;
    if (active.quietWarnTimer) clearTimeout(active.quietWarnTimer);
    this.activeTurnHealth.delete(agent);
  }

  private clearTurnHealthForAgent(agent: AgentId): void {
    this.clearTurnHealth(agent);
  }

  /**
   * A started turn has emitted no signal for the configured window. This is NOT
   * treated as a failure: a silent codex turn is almost always just doing long
   * reasoning or context compaction on a large context (codex has no heartbeat
   * during that phase), and killing it would murder healthy work. So we only
   * surface a non-fatal "agent is quiet" warning and let the turn keep running;
   * recovery from a genuine hang is the operator's call (manual restart / new
   * session). The warning re-arms with capped exponential backoff so a long
   * silence keeps surfacing without flooding.
   */
  private handleQuietTurn(active: ActiveTurnHealth): void {
    if (this.activeTurnHealth.get(active.agent) !== active) return;
    active.quietWarnTimer = undefined;
    const count = (active.quietWarnCount = (active.quietWarnCount ?? 0) + 1);
    const quietSec = Math.round((Date.parse(now()) - Date.parse(active.startedAt)) / 1000);
    const detail =
      `quiet for ${quietSec}s with no output — the agent is likely doing long reasoning ` +
      `or context compaction. It has NOT been cancelled; restart or start a new session ` +
      `manually if it is genuinely stuck.`;
    this.recordTurnHealthWarning(active, "first_signal_timeout", detail);
    const factor = Math.min(2 ** count, 8);
    active.quietWarnTimer = setTimeout(() => this.handleQuietTurn(active), this.turnFirstSignalTimeoutMs * factor);
  }

  private recordTurnHealthWarning(active: ActiveTurnHealth, reason: TurnHealthReason, detail: string): void {
    const ts = now();
    this.lastHealthFailure.set(active.agent, { reason, detail, ts });
    this.emit({ kind: "agent_turn_health", agent: active.agent, turn: active.turn, level: "warning", reason, detail, ts });
  }

  private noteExtNotification(agent: AgentId, method: string, params: unknown, turn: AgentTurn | undefined): void {
    if (method !== "_claude/sdkMessage") return;
    const health = claudeHealthSignal(params);
    if (!health) return;
    this.noteTurnSignal(agent, turn);
    this.emit({ kind: "agent_health_signal", agent, signal: health.signal, detail: health.detail, turn, ts: now() });
  }

  private noteTurnConsumed(turn: AgentTurn): void {
    const q = this.queuedTurns.get(turn.agent) ?? [];
    const idx = q.findIndex((queued) => queued.id === turn.id);
    if (idx >= 0) q.splice(idx, 1);
    if (q.length) this.queuedTurns.set(turn.agent, q);
    else this.queuedTurns.delete(turn.agent);
    this.emit({ kind: "agent_turn", phase: "consumed", turn, ts: now() });
  }

  private noteTurnRemoved(turn: AgentTurn): void {
    const q = this.queuedTurns.get(turn.agent) ?? [];
    const idx = q.findIndex((queued) => queued.id === turn.id);
    if (idx >= 0) q.splice(idx, 1);
    if (q.length) this.queuedTurns.set(turn.agent, q);
    else this.queuedTurns.delete(turn.agent);
    this.emit({ kind: "agent_turn", phase: "removed", turn, ts: now() });
  }

  private rememberConsumedMail(agent: AgentId, mailIds: Iterable<string>): void {
    let set = this.consumedMailIds.get(agent);
    if (!set) {
      set = new Set();
      this.consumedMailIds.set(agent, set);
    }
    for (const id of mailIds) set.add(id);
    while (set.size > 500) set.delete(set.values().next().value!);
  }

  private async persistRuntimeSessionFields(id: AgentId, fields: { mode?: string; model?: string; effort?: ThinkingEffort }): Promise<void> {
    if (!this.sessionRunDir) return;
    const current = this.sessionState.agents[id];
    if (!current) return;
    this.sessionState = await updateAgentSession(this.sessionRunDir, this.mesh.name, id, { ...current, ...fields });
  }

  /** Prepend the one-time mesh briefing to an agent's very first prompt, so it knows
   *  it is part of a collaborating mesh before it does any work. */
  private compose(id: AgentId, text: string): string {
    if (this.loadedSessions.has(id)) return text;
    if (this.briefed.has(id)) return text;
    this.briefed.add(id);
    const briefing = buildMeshBriefing(this.mesh, id);
    if (!briefing) return text;
    return `${briefing}\n\n---\n\nYour first task / message follows:\n\n${text}`;
  }

  private operatorTurn(id: AgentId, text: string, images: PromptImageRef[] = []): AgentTurn {
    return {
      id: randomUUID(),
      agent: id,
      source: "operator",
      from: "operator",
      to: id,
      text,
      preview: turnPreview("you", text, images),
      images: images.map(publicImageRef),
      ts: now(),
    };
  }

  private mailTurn(to: AgentId, from: AgentId, body: string, mailId?: string, mailSeq?: number): AgentTurn {
    return {
      id: randomUUID(),
      agent: to,
      source: "mail",
      from,
      to,
      text: body,
      preview: `${from}: ${compactPreview(body)}`,
      ts: now(),
      mailId,
      mailSeq,
    };
  }

  private steerTurn(to: AgentId, from: AgentId | "operator", body: string, images: PromptImageRef[] = []): AgentTurn {
    return {
      id: randomUUID(),
      agent: to,
      source: "steer",
      from,
      to,
      text: body,
      preview: turnPreview(from === "operator" ? "you" : from, body, images),
      images: images.map(publicImageRef),
      ts: now(),
    };
  }

  /** Public: send a prompt turn to an agent (the control plane is the sole driver). Image
   *  blocks are dropped for agents that did not advertise image input, so a non-image agent
   *  still gets the text turn instead of rejecting the whole prompt. */
  async prompt(id: AgentId, text: string, images: PromptImageRef[] = [], turn?: AgentTurn) {
    const imgs = this.imageCaps.get(id) ? images : [];
    const promptImages = imgs.map((i) => this.resolveImagePath(i));
    return this.promptWithResumeFallback(id, text, promptImages, false, turn ?? this.operatorTurn(id, text, imgs));
  }

  /** Remove a not-yet-started user/operator prompt from one agent's queue.
   *  Mail wakeups are deliberately not removable here because the durable mailbox
   *  remains the source of truth for inter-agent mail delivery. */
  removeQueuedTurn(id: AgentId, turnId: string): boolean {
    if (!this.mesh.agent(id)) throw new Error(`no such agent "${id}"`);
    const conn = this.conns.get(id);
    if (!conn) throw new Error(`no connection for agent ${id}`);
    const [removed] = conn.removeQueued((turn) => turn.id === turnId && (turn.source === "operator" || (turn.source === "steer" && turn.from === "operator")));
    if (!removed) return false;
    this.noteTurnRemoved(removed);
    return true;
  }

  /** Switch an agent's permission/approval mode (delegates to its connection). */
  async setMode(id: AgentId, modeId: string): Promise<void> {
    await this.agent(id).setMode(modeId);
    const modes = this.sessionModes.get(id);
    if (modes) this.sessionModes.set(id, { ...modes, current: modeId });
    await this.persistRuntimeSessionFields(id, { mode: modeId });
    // Some agents (e.g. claude) don't emit a current_mode_update after setSessionMode, so the
    // operator's picker would snap back to the old mode. Echo the change ourselves so the UI
    // reflects the switch immediately (the gateway folds current_mode_update into pm.modes).
    this.emit({ kind: "update", agent: id, update: { sessionUpdate: "current_mode_update", currentModeId: modeId }, ts: now() });
  }

  /** Switch an agent's model (delegates to its connection, then echoes state for the UI). */
  async setModel(id: AgentId, modelId: string): Promise<void> {
    await this.agent(id).setModel(modelId);
    const models = this.sessionModels.get(id);
    if (models) {
      const next = { ...models, current: modelId };
      this.sessionModels.set(id, next);
      this.emit({ kind: "agent_models", agent: id, current: next.current, available: next.available, ts: now() });
    }
    await this.persistRuntimeSessionFields(id, { model: modelId });
  }

  /** Switch an agent's runtime thinking effort where the harness supports it. */
  async setEffort(id: AgentId, effort?: string): Promise<void> {
    const agent = this.mesh.agent(id);
    if (!agent) throw new Error(`no such agent "${id}"`);
    const advertised = this.sessionEfforts.get(id);
    const runtime = runtimeEffortConfig(agent.harness, effort, advertised);
    if (runtime && this.conns.has(id) && (!advertised || advertised.available.some((o) => o.id === effort))) {
      await this.agent(id).setConfigOption(runtime.configId, runtime.value);
      if (advertised) {
        const next = { ...advertised, current: effort ?? runtime.value };
        this.sessionEfforts.set(id, next);
        this.emit({ kind: "agent_efforts", agent: id, configId: next.configId, current: next.current, available: next.available, ts: now() });
      }
    }
    if (effort === undefined || isThinkingEffort(effort)) await this.persistRuntimeSessionFields(id, { effort });
  }


  /** Operator-initiated interrupt: cancel an agent's current turn and record it.
   *  (The router can also interrupt via its mesh tool; this is the human path.) */
  async interrupt(id: AgentId, by: AgentId = "operator"): Promise<void> {
    // TODO: cancelling while a permission request is pending can leave that request visible;
    // this is pre-existing interrupt behavior and should be cleaned up with a permission-state pass.
    this.emit({ kind: "interrupt", from: by, target: id, reason: "operator interrupt", ts: now() });
    await this.agent(id).cancel();
  }

  /** Operator-initiated "switch to a fresh ACP session" for one agent.
   *  Running agents respawn fresh (forceFresh => kill + session/new + persist new id).
   *  Not-running agents (dead/cold/lazy) are NEVER spawned here — only their persisted
   *  session id is invalidated so their NEXT wake starts fresh. */
  async newSession(id: AgentId): Promise<void> {
    const a = this.mesh.agent(id);
    if (!a) throw new Error(`no such agent "${id}"`);
    const status = this.mesh.status(id);
    const live = this.conns.has(id) && status !== "dead" && status !== "cold";
    if (this.sessionRunDir) {
      this.sessionState = await clearAgentSession(this.sessionRunDir, this.mesh.name, id);
    }
    if (live) {
      await this.ensureSpawned(id, { manual: true, forceFresh: true, drainPendingMail: false });
    }
    this.emit({ kind: "update", agent: id, update: { sessionUpdate: "__session_reset__" }, ts: now() });
  }

  async respawnAgent(id: AgentId, mode: RespawnMode): Promise<RespawnResult> {
    const a = this.mesh.agent(id);
    if (!a) throw new Error(`no such agent "${id}"`);
    const status = this.mesh.status(id);
    if (status === "spawning" || status === "cold") throw new Error(`agent "${id}" is ${status}`);
    if (mode === "cancel") {
      const timer = this.pendingRespawns.get(id);
      if (timer) clearTimeout(timer);
      this.pendingRespawns.delete(id);
      this.emit({ kind: "agent_status", agent: id, status: status ?? "dead", detail: "agent respawn canceled", ts: now() });
      return { mode, scheduled: false };
    }
    if (mode === "after-idle" && this.activityOf(id) !== "idle") {
      if (!this.pendingRespawns.has(id)) {
        const timer = setTimeout(() => {
          if (this.pendingRespawns.get(id) !== timer) return;
          this.pendingRespawns.delete(id);
          this.emit({ kind: "agent_status", agent: id, status: this.mesh.status(id) ?? "dead", detail: "agent respawn timeout canceled", ts: now() });
        }, 5 * 60 * 1000);
        this.pendingRespawns.set(id, timer);
        this.emit({ kind: "agent_status", agent: id, status: status ?? "ready", detail: "agent respawn pending", ts: now() });
      }
      return { mode, scheduled: true, willRunWhen: "idle", note: "ACP session context will be lost; mailbox preserved" };
    }
    await this.forceRespawnAgent(id);
    return { mode, scheduled: false, willRunWhen: "now", note: "ACP session context will be lost; mailbox preserved" };
  }

  private async forceRespawnAgent(id: AgentId): Promise<void> {
    if (this.sessionRunDir) this.sessionState = await clearAgentSession(this.sessionRunDir, this.mesh.name, id);
    this.emit({ kind: "agent_status", agent: id, status: this.mesh.status(id) ?? "dead", detail: "force respawn", ts: now() });
    await this.ensureSpawned(id, { manual: true, forceFresh: true, drainPendingMail: false });
    this.emit({ kind: "agent_status", agent: id, status: this.mesh.status(id) ?? "ready", detail: "agent respawned (force)", ts: now() });
  }

  /** One-click: switch every agent in the mesh to a fresh session. */
  async newAllSessions(): Promise<void> {
    for (const a of this.mesh.agents) {
      await this.newSession(a.id).catch((err) => this.log(`newSession(${a.id}) failed: ${String(err)}`));
    }
  }

  /** Operator-initiated steer: priority-inject a human message without edge checks. */
  async steer(id: AgentId, text: string, images: PromptImageRef[] = []): Promise<void> {
    this.emit({ kind: "steer", from: "operator", to: id, body: text, ts: now() });
    this.steerWake(id, "operator", text, images);
  }

  get mcpServer(): MeshServicesServer {
    if (!this.mcp) throw new Error("control plane not started");
    return this.mcp;
  }

  // ---- lifecycle ----
  async start(): Promise<void> {
    await mkdir(resolve(this.mailboxPath, ".."), { recursive: true });
    this.sessionState = this.sessionRunDir
      ? await readSessionState(this.sessionRunDir, this.mesh.name)
      : { meshExpectedAlive: true, agents: {} };
    this.mailCursors.clear();
    for (const [agentId, record] of Object.entries(this.sessionState.agents)) {
      if (record.mailCursor) this.mailCursors.set(agentId, record.mailCursor);
    }
    await this.compactMailboxNow();
    this.recentMail = (await readUnreadAddressedMail({ mailboxPath: this.mailboxPath, cursors: this.mailboxCursorsSnapshot() })).map((event) => ({
      id: event.id,
      from: event.from,
      to: (event.meta as { to?: string }).to!,
      body: event.body,
      ts: event.ts,
    }));
    // Recover the mail seq counter and reply-quote map across daemon restarts. The
    // recent window (live + archive) always contains the highest seq issued so far.
    for (const event of await readRecentAddressedMail({ mailboxPath: this.mailboxPath })) {
      const meta = event.meta as MailMeta | undefined;
      if (!meta?.seq) continue;
      this.mailSeq = Math.max(this.mailSeq, meta.seq);
      this.rememberMailSeq(meta.seq, { from: event.from, to: meta.to, body: event.body });
    }

    this.mcp = this.meshServicesFactory({
      meshStatus: (ctx) => this.meshStatusText(ctx.agentId),
      meshBriefing: (ctx) => this.meshBriefingText(ctx.agentId),
      sendMail: (ctx, to, body, opts) => this.handleSendMail(ctx, to, body, opts),
      steerMail: (ctx, to, body) => this.handleSteerMail(ctx, to, body),
      steerTargets: (ctx) => this.steerTargets(ctx.agentId),
      checkMail: (ctx) => this.handleCheckMail(ctx),
      interrupt: (ctx, target, reason) => this.handleInterrupt(ctx, target, reason),
    });

    if (!this.sessionState.meshExpectedAlive) {
      for (const a of this.mesh.agents) {
        this.mesh.setStatus(a.id, "dead");
        this.emit({ kind: "agent_status", agent: a.id, status: "dead", detail: "stopped", ts: now() });
      }
      return;
    }

    for (const a of this.mesh.agents) {
      if (a.lazy) {
        this.mesh.setStatus(a.id, "cold");
        this.emit({ kind: "agent_status", agent: a.id, status: "cold", ts: now() });
        continue;
      }
      await this.spawnAgent(a, { drainPendingMail: false });
    }
  }

  async stop(reason: ControlPlaneStopReason = "shutdown"): Promise<void> {
    if ((reason === "explicit" || reason === "idle") && this.sessionRunDir) {
      this.sessionState = await setMeshExpectedAlive(this.sessionRunDir, this.mesh.name, false);
    }
    await this.compactMailboxNow();
    for (const a of this.mesh.agents) this.clearTurnHealthForAgent(a.id);
    for (const c of this.conns.values()) c.kill();
    for (const timer of this.pendingRespawns.values()) clearTimeout(timer);
    this.pendingRespawns.clear();
    this.resolvedHarnesses.clear();
    this.mcp?.close();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.spawning.clear();
    this.loadedSessions.clear();
    this.resumePendingValidation.clear();
  }

  // Re-register on EVERY (re)spawn. The per-agent MCP transport binds a single
  // session on first `initialize`; reusing it across a respawn makes the new
  // agent process's handshake fail with "Server already initialized", so it comes
  // back without mesh tools. Registering afresh each spawn rebuilds the transport.
  private async ensureMcpRegistered(agent: AgentConfig): Promise<void> {
    if (!this.mcp) throw new Error("control plane not started");
    await this.mcp.register(agent.id, agent.role);
  }

  private async spawnAgent(a: AgentConfig, opts: { drainPendingMail: boolean; forceFresh?: boolean }): Promise<AcpAgentConnection> {
    if (!this.mcp) throw new Error("control plane not started");
    await this.ensureMcpRegistered(a);

    const existing = this.conns.get(a.id);
    if (existing) {
      existing.kill();
      this.conns.delete(a.id);
    }

    // Per-agent spawn config applies the chosen thinking effort (codex flag / claude env);
    // codex defaults to "low" for responsiveness when no effort is set.
    const { command, args, env } = spawnConfigFor(a);
    const cwd = resolve(process.cwd(), a.project);
    const artifactDir = this.artifactsRoot ? artifactAgentDir(this.artifactsRoot, this.mesh.name, a.id) : undefined;
    if (artifactDir) await mkdir(artifactDir, { recursive: true });
    const conn = this.connectionFactory({
      id: a.id,
      command,
      args,
      cwd,
      extraEnv: artifactDir ? { ...env, AGENT_MESH_ARTIFACTS: artifactDir } : env,
      debug: this.debug,
      onUpdate: (u) => {
        if (u && (u as any).sessionUpdate === "current_mode_update" && typeof (u as any).currentModeId === "string") {
          const modeId = (u as any).currentModeId;
          const modes = this.sessionModes.get(a.id);
          if (modes) this.sessionModes.set(a.id, { ...modes, current: modeId });
          this.persistRuntimeSessionFields(a.id, { mode: modeId }).catch((err) => this.log(`persist mode ${a.id}=${modeId} failed: ${String(err)}`));
        }
        this.emit({ kind: "update", agent: a.id, update: u, ts: now() });
      },
      onPermission: (req) => this.handlePermission(a.id, req),
      onPromptQueued: (turn) => this.noteTurnQueued(turn),
      onPromptStarted: (turn) => this.noteTurnStarted(turn),
      onPromptSignal: (turn) => this.noteTurnSignal(a.id, turn),
      onExtNotification: (method, params, turn) => this.noteExtNotification(a.id, method, params, turn),
      onExit: (code) => {
        if (this.conns.get(a.id) !== conn) return;
        this.clearTurnHealthForAgent(a.id);
        this.resolvedHarnesses.delete(a.id);
        this.mesh.setStatus(a.id, "dead");
        this.turnCounts.set(a.id, 0);
        this.clearQueuedTurns(a.id);
        this.emitActivityIfChanged(a.id);
        this.emit({ kind: "agent_status", agent: a.id, status: "dead", detail: `exit ${code}`, ts: now() });
      },
    });
    this.conns.set(a.id, conn);

    this.mesh.setStatus(a.id, "spawning");
    this.emit({ kind: "agent_status", agent: a.id, status: "spawning", ts: now() });
    let initialized = false;
    try {
      await mkdir(cwd, { recursive: true });
      await conn.start();
      const initRes = await conn.initialize();
      const resolvedHarness = {
        agentId: a.id,
        harnessId: a.harness,
        path: Bun.which(command) ?? undefined,
        version: typeof (initRes as any)?.agentInfo?.version === "string" ? (initRes as any).agentInfo.version : undefined,
        spawnedAt: now(),
      };
      this.resolvedHarnesses.set(a.id, resolvedHarness);
      this.emit({ kind: "agent_resolved_harness", agent: a.id, harness: a.harness, path: resolvedHarness.path, version: resolvedHarness.version, spawnedAt: resolvedHarness.spawnedAt, ts: now() });
      const mcpServers = [{ type: "http", name: "mesh", url: this.mcp.urlFor(a.id), headers: [] }];
      const saved = this.sessionState.agents[a.id];
      let loaded = false;
      let session: unknown;
      if (!opts.forceFresh && conn.supportsLoadSession && saved?.sessionId) {
        try {
          session = await conn.loadSession(saved.sessionId, saved.cwd, mcpServers);
          loaded = true;
        } catch (err) {
          this.log(`resume ${a.id} failed: ${String(err)}; starting fresh`);
        }
      }
      if (!session) {
        session = await conn.newSession(mcpServers);
      }
      initialized = true;

      if (loaded) {
        this.loadedSessions.add(a.id);
        this.resumePendingValidation.add(a.id);
      } else {
        this.loadedSessions.delete(a.id);
        this.resumePendingValidation.delete(a.id);
        this.briefed.delete(a.id);
      }

      // Surface the agent's advertised session modes so the operator gets a real picker
      // (read-only / full-access / plan / …) instead of having to know mode-id strings.
      const desiredMode = saved?.mode ?? a.mode;
      const desiredModel = saved?.model ?? a.model;
      const standardModes = (session as any)?.modes;
      const configMode = deriveConfigOption(session, "mode");
      const available = ((standardModes?.availableModes ?? []).length
        ? (standardModes.availableModes ?? []).map((mo: any) => ({ id: mo.id, name: mo.name ?? mo.id, description: mo.description ?? undefined }))
        : (configMode?.available ?? [])) as SessionMode[];
      // Apply a configured initial permission/session mode (best-effort) before the first turn.
      let current: string = standardModes?.currentModeId ?? configMode?.current ?? available[0]?.id ?? "";
      const desiredEffort = saved?.effort ?? a.effort;
      if (desiredMode && available.some((mo: any) => mo.id === desiredMode)) {
        try {
          await conn.setMode(desiredMode);
          current = desiredMode;
        } catch (err) {
          this.log(`set cached mode ${a.id}=${desiredMode} failed: ${String(err)}`);
        }
      } else if (desiredMode && available.length) {
        this.log(`skip cached mode ${a.id}=${desiredMode}: not advertised`);
      }
      if (available.length) {
        this.sessionModes.set(a.id, { current, available });
        this.emit({ kind: "agent_modes", agent: a.id, current, available, ts: now() });
      }
      const configModel = deriveConfigOption(session, "model");
      const standardModel = deriveStandardModels(session);
      const displayModel = configModel?.available.length ? configModel : standardModel;
      let currentModel: string | undefined = desiredModel;
      if (displayModel?.available.length) {
        currentModel = displayModel.current;
        const desiredSetModel = desiredModel ? resolveDesiredModel(a, desiredModel, standardModel, configModel) : undefined;
        if (desiredSetModel) {
          try {
            await conn.setModel(desiredSetModel);
            currentModel = desiredSetModel;
          } catch (err) {
            this.log(`set cached model ${a.id}=${desiredSetModel} failed: ${String(err)}`);
          }
        } else if (desiredModel) {
          console.warn(`skip cached model ${a.id}=${desiredModel}: not advertised`);
          this.log(`skip cached model ${a.id}=${desiredModel}: not advertised`);
        }
        const eventCurrent = displayModelCurrent(currentModel, displayModel.current, displayModel.available);
        this.sessionModels.set(a.id, { current: eventCurrent, available: displayModel.available });
        this.emit({ kind: "agent_models", agent: a.id, current: eventCurrent, available: displayModel.available, ts: now() });
      }
      const configEffort = runtimeEffortOptionsFromSession(a.harness, session);
      if (configEffort?.available.length) {
        let currentEffort = configEffort.current;
        if (desiredEffort && configEffort.available.some((o) => o.id === desiredEffort)) {
          try {
            const runtime = runtimeEffortConfig(a.harness, desiredEffort, configEffort);
            if (runtime) {
              await conn.setConfigOption(runtime.configId, runtime.value);
              currentEffort = desiredEffort;
            }
          } catch (err) {
            this.log(`set cached effort ${a.id}=${desiredEffort} failed: ${String(err)}`);
          }
        } else if (desiredEffort) {
          this.log(`skip cached effort ${a.id}=${desiredEffort}: not advertised`);
        }
        const next = { ...configEffort, current: currentEffort };
        this.sessionEfforts.set(a.id, next);
        this.emit({ kind: "agent_efforts", agent: a.id, configId: next.configId, current: next.current, available: next.available, ts: now() });
      }
      if (this.sessionRunDir && typeof (session as any)?.sessionId === "string") {
        this.sessionState = await updateAgentSession(this.sessionRunDir, this.mesh.name, a.id, {
          sessionId: (session as any).sessionId,
          cwd,
          harness: a.harness,
          model: currentModel,
          mode: current || desiredMode,
          effort: a.effort,
        });
      }
      const imageCap = !!(initRes as any)?.agentCapabilities?.promptCapabilities?.image;
      this.imageCaps.set(a.id, imageCap);
      this.emit({ kind: "agent_capabilities", agent: a.id, image: imageCap, ts: now() });
      if (this.conns.get(a.id) !== conn) {
        conn.kill();
        this.resolvedHarnesses.delete(a.id);
        throw new Error(`spawn for ${a.id} was superseded`);
      }
      this.mesh.setStatus(a.id, "ready");
      this.emit({ kind: "agent_status", agent: a.id, status: "ready", ts: now() });
      this.spawnFails.delete(a.id);
      if (opts.drainPendingMail) this.drainPendingMail(a.id);
      return conn;
    } catch (err) {
      if (!initialized) {
        this.sessionModes.delete(a.id);
        this.sessionModels.delete(a.id);
        this.imageCaps.delete(a.id);
        this.resolvedHarnesses.delete(a.id);
      }
      conn.kill();
      if (this.conns.get(a.id) === conn) {
        this.conns.delete(a.id);
        this.clearQueuedTurns(a.id);
        this.emitActivityIfChanged(a.id);
        this.mesh.setStatus(a.id, "dead");
        this.emit({ kind: "agent_status", agent: a.id, status: "dead", detail: String(err), ts: now() });
      }
      throw err;
    }
  }

  private async ensureSpawned(id: AgentId, opts: { manual?: boolean; forceFresh?: boolean; drainPendingMail?: boolean } = {}): Promise<AcpAgentConnection> {
    const a = this.mesh.agent(id);
    if (!a) throw new Error(`no such agent "${id}"`);
    if (!opts.forceFresh && this.mesh.status(id) === "ready" && this.conns.has(id)) return this.conns.get(id)!;
    if (opts.manual) this.spawnFails.delete(id);
    const existing = this.spawning.get(id);
    if (existing) return existing;
    const generation = (this.spawnGeneration.get(id) ?? 0) + 1;
    this.spawnGeneration.set(id, generation);
    const p = this.withSpawnTimeout(id, generation, this.spawnAgent(a, { drainPendingMail: opts.drainPendingMail ?? true, forceFresh: opts.forceFresh }))
      .then((conn) => {
        if (this.spawnGeneration.get(id) !== generation || this.mesh.status(id) === "stopped") {
          conn.kill();
          if (this.conns.get(id) === conn) this.conns.delete(id);
          throw new Error(`spawn for ${id} was stopped`);
        }
        return conn;
      })
      .catch((err) => {
        if (this.spawnGeneration.get(id) === generation && this.mesh.status(id) !== "stopped") this.spawnFails.set(id, (this.spawnFails.get(id) ?? 0) + 1);
        throw err;
      })
      .finally(() => {
        if (this.spawning.get(id) === p) this.spawning.delete(id);
      });
    this.spawning.set(id, p);
    return p;
  }

  private async withSpawnTimeout<T>(id: AgentId, generation: number, spawn: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const conn = this.conns.get(id);
        if (this.spawnGeneration.get(id) === generation) conn?.kill();
        if (conn && this.spawnGeneration.get(id) === generation && this.conns.get(id) === conn) {
          this.conns.delete(id);
          this.mesh.setStatus(id, "dead");
          this.clearQueuedTurns(id);
          this.emitActivityIfChanged(id);
          this.emit({ kind: "agent_status", agent: id, status: "dead", detail: `spawn timed out after ${this.spawnTimeoutMs}ms`, ts: now() });
        }
        reject(new Error(`spawn for ${id} timed out after ${this.spawnTimeoutMs}ms`));
      }, this.spawnTimeoutMs);
    });
    try {
      return await Promise.race([spawn, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private drainPendingMail(id: AgentId): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    const prompt = this.compose(
      id,
      "You may have pending mail that arrived while you were cold or spawning. Please call check_mail now and handle all pending messages.",
    );
    this.trackTurn(id, () => conn.prompt(prompt)).catch((err) => this.log(`drainPendingMail(${id}) failed: ${String(err)}`));
  }

  async wakeAgent(id: AgentId): Promise<void> {
    await this.ensureSpawned(id, { manual: true, forceFresh: this.shouldForceFreshForEngagement(id) });
  }

  async stopAgent(id: AgentId): Promise<void> {
    if (!this.mesh.agent(id)) throw new Error(`no such agent "${id}"`);
    this.spawnGeneration.set(id, (this.spawnGeneration.get(id) ?? 0) + 1);
    this.clearTurnHealthForAgent(id);
    const conn = this.conns.get(id);
    if (conn) {
      conn.kill();
      this.conns.delete(id);
    }
    this.spawning.delete(id);
    this.sessionModes.delete(id);
    this.sessionModels.delete(id);
    this.imageCaps.delete(id);
    this.resolvedHarnesses.delete(id);
    this.loadedSessions.delete(id);
    this.resumePendingValidation.delete(id);
    this.mesh.setStatus(id, "stopped");
    this.turnCounts.delete(id);
    this.clearQueuedTurns(id);
    this.emitActivityIfChanged(id);
    this.emit({ kind: "agent_status", agent: id, status: "stopped", detail: "manual stop", ts: now() });
  }

  private promptWithResumeFallback(
    id: AgentId,
    text: string,
    images: PromptImageRef[],
    steer: boolean,
    turn?: AgentTurn,
  ): Promise<unknown> {
    const existing = this.conns.get(id);
    if (existing && this.mesh.status(id) !== "dead" && this.mesh.status(id) !== "cold") {
      return this.sendPromptWithResumeFallback(id, text, images, steer, existing, turn);
    }
    return this.ensureSpawned(id, { manual: true, forceFresh: this.shouldForceFreshForEngagement(id), drainPendingMail: false })
      .then((conn) => this.sendPromptWithResumeFallback(id, text, images, steer, conn, turn));
  }

  private async sendPromptWithResumeFallback(
    id: AgentId,
    text: string,
    images: PromptImageRef[],
    steer: boolean,
    conn: AcpAgentConnection,
    turn?: AgentTurn,
  ): Promise<unknown> {
    const prompt = this.compose(id, text);
    try {
      const result = await this.trackTurn(
        id,
        () => steer ? conn.steerPrompt(prompt, images, turn) : conn.prompt(prompt, images, turn),
      ).finally(() => this.finishTurnHealth(id, turn));
      this.resumePendingValidation.delete(id);
      return result;
    } catch (err) {
      if (!this.resumePendingValidation.has(id)) throw err;
      this.log(`first prompt after resume failed for ${id}: ${String(err)}; starting fresh`);
      this.resumePendingValidation.delete(id);
      conn = await this.ensureSpawned(id, { manual: true, forceFresh: true, drainPendingMail: false });
      const retryPrompt = this.compose(id, text);
      return this.trackTurn(
        id,
        () => steer ? conn.steerPrompt(retryPrompt, images, turn) : conn.prompt(retryPrompt, images, turn),
      ).finally(() => this.finishTurnHealth(id, turn));
    }
  }

  private shouldForceFreshForEngagement(id: AgentId): boolean {
    return !this.sessionState.meshExpectedAlive || this.mesh.status(id) === "dead";
  }

  addEdge(edge: MeshEdge): void {
    const normalized = validateAddEdge(this.mesh.config, edge, (id) => this.mesh.status(id));
    this.mesh.addEdge(normalized);
    this.dynamicEdges.add(edgeKey(normalized.from, normalized.to));
    this.emit({ kind: "log", text: `edge added ${normalized.from} -> ${normalized.to}${normalized.steer ? " (steer)" : ""}`, ts: now() });
  }

  addAgent(cfg: AgentConfig, edges: MeshEdge[] = []): void {
    const agent = validateAddAgent(this.mesh.config, cfg);
    let staged: MeshConfig = { ...this.mesh.config, agents: [...this.mesh.config.agents, agent], edges: [...this.mesh.config.edges] };
    const normalizedEdges: MeshEdge[] = [];
    for (const edgeInput of edges) {
      const edge = validateAddEdge(staged, edgeInput, (id) => (id === agent.id ? "cold" : this.mesh.status(id)));
      normalizedEdges.push(edge);
      staged = { ...staged, edges: [...staged.edges, edge] };
    }
    this.mesh.addAgent(agent);
    this.emit({ kind: "agent_status", agent: agent.id, status: "cold", ts: now() });
    this.emit({ kind: "agent_activity", agent: agent.id, activity: this.activityOf(agent.id), ts: now() });
    for (const edge of normalizedEdges) this.addEdge(edge);
    this.emit({ kind: "log", text: `agent added ${agent.id} (${agent.harness})`, ts: now() });
  }

  // ---- mesh tool handlers ----
  private meshStatusText(forAgent: AgentId): string {
    const lines = this.mesh.agents.map((a) => {
      const reach = this.mesh.agents
        .filter((o) => o.id !== a.id && this.mesh.canMail(a.id, o.id))
        .map((o) => o.id);
      const me = a.id === forAgent ? " (you)" : "";
      const health = this.lastHealthFailure.get(a.id);
      const healthText = health ? ` last health note: ${health.reason} (${health.detail})` : "";
      return `- ${a.id}${me} [${a.harness}, ${a.role}, ${this.mesh.status(a.id)}, ${this.activityOf(a.id)}] can mail: ${reach.join(", ") || "(none)"}${healthText}`;
    });
    return `Mesh "${this.mesh.name}" — router is ${this.mesh.router.id}.\n${lines.join("\n")}`;
  }

  private meshBriefingText(forAgent: AgentId): string {
    const briefing = buildMeshBriefing(this.mesh, forAgent);
    if (!briefing) return `error: no agent "${forAgent}" in this mesh`;
    return (
      `(Generated ${now()} from the live mesh configuration — authoritative over any earlier ` +
      `briefing you remember.)\n\n${briefing}`
    );
  }

  private steerTargets(from: AgentId): AgentId[] {
    return this.mesh.agents.filter((agent) => agent.id !== from && this.mesh.canSteer(from, agent.id)).map((agent) => agent.id);
  }

  private activityOf(id: AgentId): AgentActivity {
    if (this.mesh.status(id) === "dead") return "idle";
    return (this.turnCounts.get(id) ?? 0) > 0 ? "working" : "idle";
  }

  private emitActivityIfChanged(id: AgentId): void {
    const activity = this.activityOf(id);
    if ((this.activityStates.get(id) ?? "idle") === activity) return;
    this.activityStates.set(id, activity);
    this.emit({ kind: "agent_activity", agent: id, activity, ts: now() });
  }

  private trackTurn<T>(id: AgentId, start: () => Promise<T>): Promise<T> {
    this.turnCounts.set(id, (this.turnCounts.get(id) ?? 0) + 1);
    this.emitActivityIfChanged(id);
    let turn: Promise<T>;
    try {
      turn = start();
    } catch (err) {
      this.finishTurn(id);
      throw err;
    }
    return turn.finally(() => this.finishTurn(id));
  }

  private finishTurn(id: AgentId): void {
    const next = Math.max(0, (this.turnCounts.get(id) ?? 0) - 1);
    if (next === 0) this.turnCounts.delete(id);
    else this.turnCounts.set(id, next);
    this.emitActivityIfChanged(id);
    if (next === 0) void this.runPendingRespawn(id);
  }

  private async runPendingRespawn(id: AgentId): Promise<void> {
    const timer = this.pendingRespawns.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingRespawns.delete(id);
    await this.forceRespawnAgent(id).catch((err) => this.log(`pending respawn ${id} failed: ${String(err)}`));
  }

  /** Render the delivery header for a mail: [MAIL #7 from lead | task: x | in reply to #5]. */
  private renderMailHeader(from: string, meta: MailDeliveryMeta, kind = "MAIL"): string {
    const parts = [`${kind}${meta.seq !== undefined ? ` #${meta.seq}` : ""} from ${from}`];
    if (meta.task) parts.push(`task: ${meta.task}`);
    if (meta.replyTo !== undefined) parts.push(`in reply to #${meta.replyTo}`);
    return `[${parts.join(" | ")}]`;
  }

  /** Quote the referenced mail so the recipient doesn't have to reconstruct the thread. */
  private renderReplyQuote(replyTo?: number): string {
    if (replyTo === undefined) return "";
    const ref = this.mailBySeq.get(replyTo);
    if (!ref) return "";
    return `\n(#${replyTo}, ${ref.from} → ${ref.to}, was: "${compactPreview(ref.body)}")`;
  }

  private rememberMailSeq(seq: number, summary: { from: string; to: string; body: string }): void {
    this.mailBySeq.set(seq, summary);
    while (this.mailBySeq.size > 500) this.mailBySeq.delete(this.mailBySeq.keys().next().value!);
  }

  private async handleSendMail(ctx: MeshToolContext, to: AgentId, body: string, opts: SendMailOptions = {}): Promise<string> {
    if (!this.mesh.agent(to)) return `error: no such agent "${to}" in this mesh`;
    if (!this.mesh.canMail(ctx.agentId, to)) {
      return `error: you (${ctx.agentId}) are not allowed to mail ${to}`;
    }
    const seq = ++this.mailSeq;
    const meta: MailDeliveryMeta = { seq, replyTo: opts.replyTo, task: opts.task };
    const event = await sendMail({
      mailboxPath: this.mailboxPath,
      mesh: this.mesh.name,
      from: ctx.agentId,
      to,
      body,
      seq,
      replyTo: opts.replyTo,
      task: opts.task,
    });
    this.pushRecentMail({ id: event.id, from: ctx.agentId, to, body, ts: event.ts });
    this.emit({ kind: "mail", id: event.id, from: ctx.agentId, to, body, ts: event.ts });
    // Wake the recipient asynchronously (fire-and-forget; sender's tool returns now).
    const target = this.mesh.agent(to);
    if (this.mesh.status(to) === "stopped") {
      // Manual stop is sticky for peer mail: the durable mail remains readable, but
      // only an explicit wake or operator prompt restarts the agent.
    } else if (target?.lazy && this.mesh.status(to) !== "ready") this.wakeLazy(to, ctx.agentId, body, event.id, meta);
    else this.wake(to, ctx.agentId, body, event.id, meta);
    const notes: string[] = [];
    if (opts.replyTo !== undefined && !this.mailBySeq.has(opts.replyTo)) {
      notes.push(`note: reply_to #${opts.replyTo} does not match any known mail; delivered anyway without a quote.`);
    }
    if (this.dynamicEdges.has(edgeKey(ctx.agentId, to))) {
      notes.push(`note: ${to} may have been added after your session started; current status is ${this.mesh.status(to) ?? "unknown"}.`);
    }
    // Remember AFTER the reply_to check so a mail cannot satisfy its own reference.
    this.rememberMailSeq(seq, { from: ctx.agentId, to, body });
    return [`queued for ${to} as #${seq}; wake scheduled`, ...notes].join("\n");
  }

  private wakeLazy(to: AgentId, from: AgentId, body: string, mailId?: string, meta: MailDeliveryMeta = {}): void {
    if ((this.spawnFails.get(to) ?? 0) >= 3) {
      this.sendSpawnFailedReceipt(to, from, "spawn fuse is locked after 3 consecutive failures; use manual wake to retry");
      return;
    }
    this.ensureSpawned(to, { forceFresh: this.shouldForceFreshForEngagement(to), drainPendingMail: false })
      .then(() => this.wake(to, from, body, mailId, meta))
      .catch((err) => this.sendSpawnFailedReceipt(to, from, String(err)));
  }

  private sendSpawnFailedReceipt(to: AgentId, from: AgentId, detail: string): void {
    const body = `[SPAWN FAILED] ${to} could not be started. ${detail}`;
    const seq = ++this.mailSeq;
    void sendMail({ mailboxPath: this.mailboxPath, mesh: this.mesh.name, from: to, to: from, body, seq })
      .then((event) => {
        this.rememberMailSeq(seq, { from: to, to: from, body });
        this.pushRecentMail({ id: event.id, from: to, to: from, body, ts: event.ts });
        this.emit({ kind: "mail", id: event.id, from: to, to: from, body, ts: event.ts });
        this.wake(from, to, body, event.id, { seq });
      })
      .catch((err) => this.log(`spawn failed receipt ${to}->${from} failed: ${String(err)}`));
  }

  private wake(to: AgentId, from: AgentId, body: string, mailId?: string, meta: MailDeliveryMeta = {}): void {
    if (mailId && this.consumedMailIds.get(to)?.has(mailId)) return;
    const mail =
      `${this.renderMailHeader(from, meta)}: ${body}` +
      this.renderReplyQuote(meta.replyTo) +
      `\n\n${MAIL_WAKE_GUIDANCE}`;
    this.prompt(to, mail, [], this.mailTurn(to, from, body, mailId, meta.seq)).catch((err) => this.log(`wake(${to}) failed: ${String(err)}`));
  }

  private async handleSteerMail(ctx: MeshToolContext, to: AgentId, body: string): Promise<string> {
    if (!this.mesh.agent(to)) return `error: no such agent "${to}" in this mesh; use send_mail for ordinary delivery`;
    if (to === ctx.agentId) return `error: cannot steer yourself; use send_mail for ordinary delivery`;
    if (!this.mesh.canMail(ctx.agentId, to)) {
      return `error: you (${ctx.agentId}) are not allowed to mail ${to}; use send_mail only for permitted ordinary delivery`;
    }
    if (!this.mesh.canSteer(ctx.agentId, to)) {
      const detail = to === this.mesh.router.id ? `cannot steer the router ${to}` : `steer is not enabled from ${ctx.agentId} to ${to}`;
      return `error: ${detail}; use send_mail for ordinary queued delivery`;
    }
    const seq = ++this.mailSeq;
    await sendMail({ mailboxPath: this.mailboxPath, mesh: this.mesh.name, from: ctx.agentId, to, body, steer: true, seq });
    this.rememberMailSeq(seq, { from: ctx.agentId, to, body });
    if (this.mesh.status(to) === "stopped") {
      return `error: ${to} is manually stopped; steer mail was persisted as #${seq} but the agent was not started`;
    }
    this.emit({ kind: "steer", from: ctx.agentId, to, body, ts: now() });
    this.steerWake(to, ctx.agentId, body, [], seq);
    return `steered to ${to} as #${seq}`;
  }

  private async steerWake(to: AgentId, from: AgentId | "operator", body: string, images: PromptImageRef[] = [], seq?: number): Promise<void> {
    const mail =
      `${this.renderMailHeader(from, { seq }, "STEER")}: ${body}\n\n` +
      `This interrupted your current turn and was placed ahead of ordinary queued mail. ` +
      `Read it and adjust course appropriately.`;
    const promptImages = images.map((i) => this.resolveImagePath(i));
    const turn = this.steerTurn(to, from, body, images);
    await this.promptWithResumeFallback(to, mail, promptImages, true, turn).catch((err) => this.log(`steerWake(${to}) failed: ${String(err)}`));
  }

  private resolveImagePath(image: PromptImageRef): PromptImageRef {
    if (image.path || !this.uploadRoot || !image.bucket) return image;
    return { ...image, path: join(this.uploadRoot, image.bucket, image.id) };
  }

  private async handleCheckMail(ctx: MeshToolContext): Promise<string> {
    const cursor = this.mailCursors.get(ctx.agentId) ?? this.sessionState.agents[ctx.agentId]?.mailCursor;
    const unread = await readMailFor(ctx.agentId, { mailboxPath: this.mailboxPath, sinceId: cursor });
    if (unread.length === 0) {
      // Nudge pollers at the moment of the bad behavior: repeated empty checks in a
      // short window mean the agent is busy-waiting instead of ending its turn.
      const nowMs = Date.now();
      const track = this.emptyMailChecks.get(ctx.agentId);
      const streak = track && nowMs - track.last < 120_000 ? track.count + 1 : 1;
      this.emptyMailChecks.set(ctx.agentId, { count: streak, last: nowMs });
      if (streak >= 2) {
        return (
          "no new mail. Reminder: mail is PUSH-delivered — it arrives automatically as a new message, " +
          "so polling check_mail gains nothing. If you are waiting for a reply, end your turn now; " +
          "the reply will wake you."
        );
      }
      return "no new mail";
    }
    this.emptyMailChecks.delete(ctx.agentId);
    // Cap the batch so one call can't blow up the tool result; the cursor only
    // advances past what is actually returned, so the rest stays unread.
    const mail: typeof unread = [];
    let bytes = 0;
    for (const m of unread) {
      const size = Buffer.byteLength(m.body, "utf8");
      if (mail.length > 0 && (mail.length >= this.checkMailMaxCount || bytes + size > this.checkMailMaxBytes)) break;
      mail.push(m);
      bytes += size;
    }
    const remaining = unread.length - mail.length;
    const nextCursor = mail[mail.length - 1]!.id;
    if (this.sessionRunDir) {
      // Crash safety is at-least-once: if the daemon is killed before this
      // atomic cursor write, this same returned batch can be delivered again.
      this.sessionState = await updateAgentMailCursor(this.sessionRunDir, this.mesh.name, ctx.agentId, nextCursor);
    }
    this.mailCursors.set(ctx.agentId, nextCursor);
    const readIds = new Set(mail.map((m) => m.id));
    this.rememberConsumedMail(ctx.agentId, readIds);
    // The agent has now read these mails inside its current turn; cancel their
    // still-queued wake turns so they neither linger in the UI queue nor start
    // a duplicate ACP turn later.
    const conn = this.conns.get(ctx.agentId);
    if (conn) {
      for (const turn of conn.removeQueued((t) => t.source === "mail" && !!t.mailId && readIds.has(t.mailId))) {
        this.noteTurnConsumed(turn);
      }
    }
    this.compactMailboxIfOverThreshold();
    const lines = mail.map((m) => {
      const meta = m.meta as (MailMeta & { from?: string }) | undefined;
      const header = this.renderMailHeader(meta?.from ?? m.from, {
        seq: meta?.seq,
        replyTo: meta?.replyTo,
        task: m.taskId && m.taskId !== "default" ? m.taskId : undefined,
      });
      return `${header}: ${m.body}${this.renderReplyQuote(meta?.replyTo)}`;
    });
    if (remaining > 0) lines.push(`[${remaining} more message${remaining === 1 ? "" : "s"} pending; call check_mail again to continue]`);
    return lines.join("\n");
  }

  private mailboxCursorsSnapshot(): Record<string, string | undefined> {
    const cursors: Record<string, string | undefined> = {};
    for (const a of this.mesh.agents) {
      cursors[a.id] = this.mailCursors.get(a.id) ?? this.sessionState.agents[a.id]?.mailCursor;
    }
    return cursors;
  }

  private async compactMailboxNow(): Promise<void> {
    await compactMailbox({ mailboxPath: this.mailboxPath, cursors: this.mailboxCursorsSnapshot(), archiveCap: this.mailboxArchiveMaxEvents });
  }

  private compactMailboxSoon(): void {
    const cursors = this.mailboxCursorsSnapshot();
    void compactMailbox({ mailboxPath: this.mailboxPath, cursors, archiveCap: this.mailboxArchiveMaxEvents }).catch((err) => this.log(`compact mailbox failed: ${String(err)}`));
  }

  private compactMailboxIfOverThreshold(): void {
    void this.shouldCompactMailbox()
      .then((shouldCompact) => {
        if (shouldCompact) this.compactMailboxSoon();
      })
      .catch((err) => this.log(`check mailbox compact threshold failed: ${String(err)}`));
  }

  private async shouldCompactMailbox(): Promise<boolean> {
    const size = await stat(this.mailboxPath).then((s) => s.size, () => 0);
    if (size >= this.mailboxCompactThresholdBytes) return true;
    if (this.mailboxCompactThresholdEvents === Number.POSITIVE_INFINITY) return false;
    if (this.mailboxCompactThresholdEvents <= 0) return true;
    const events = await readMailboxEvents(this.mailboxPath);
    return events.length >= this.mailboxCompactThresholdEvents;
  }

  private async handleInterrupt(ctx: MeshToolContext, target: AgentId, reason?: string): Promise<string> {
    if (ctx.role !== "router") return `error: only the router may interrupt`;
    if (!this.conns.has(target)) return `error: no such agent "${target}"`;
    this.emit({ kind: "interrupt", from: ctx.agentId, target, reason, ts: now() });
    await this.agent(target).cancel();
    return `interrupted ${target}`;
  }

  // ---- permission escalation ----
  private static readonly MESH_TOOLS = new Set(["send_mail", "steer_mail", "check_mail", "interrupt", "mesh_status"]);

  /**
   * Is this permission request for one of OUR injected mesh tools? Match the
   * canonical tool identifier exactly (bare name, or the `mcp__mesh__<tool>`
   * namespaced form emitted by MCP clients for our server, which we named
   * "mesh"). We deliberately do NOT substring-match or trust agent-supplied
   * free-text (e.g. rawInput.name / a file path), so a member's real op that
   * merely contains "interrupt" still escalates to a human.
   */
  private isMeshTool(toolName: string): boolean {
    if (ControlPlane.MESH_TOOLS.has(toolName)) return true;
    const m = toolName.match(/^mcp__mesh__(.+)$/);
    return m ? ControlPlane.MESH_TOOLS.has(m[1]!) : false;
  }

  private handlePermission(agentId: AgentId, req: any): Promise<PermissionDecision> {
    // Internal mesh-coordination tools are pre-authorized by mesh membership;
    // only external/dangerous operations escalate to a human.
    const toolName = String(req.toolCall?.toolName ?? req.toolCall?.title ?? "");
    if (this.isMeshTool(toolName)) {
      const allow = (req.options ?? []).find((o: any) => o.kind === "allow_once") ?? (req.options ?? [])[0];
      this.log(`auto-approved mesh tool: ${toolName || "(unknown)"} for ${agentId}`);
      return Promise.resolve(allow ? { optionId: allow.optionId } : "cancel");
    }

    const requestId = randomUUID();
    const options = (req.options ?? []).map((o: any) => ({
      id: o.optionId,
      name: o.name,
      kind: o.kind,
    }));
    const question = req.toolCall?.title ?? req.toolCall?.rawInput?.command ?? "permission requested";

    this.emit({ kind: "permission", agent: agentId, requestId, question: String(question), options, ts: now() });

    return new Promise<PermissionDecision>((resolveDecision) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const reject = (req.options ?? []).find((o: any) => o.kind?.startsWith("reject"));
        const decision: PermissionDecision = reject ? { optionId: reject.optionId } : "cancel";
        this.emit({
          kind: "permission_resolved",
          agent: agentId,
          requestId,
          optionId: reject?.optionId ?? "cancel",
          by: "timeout",
          ts: now(),
        });
        resolveDecision(decision);
      }, this.permissionTimeoutMs);
      this.pending.set(requestId, { resolve: resolveDecision, timer });
    });
  }

  /** Resolve a pending permission request (called by the TUI/human or e2e). */
  resolveDecision(requestId: string, optionId: string, by: "human" | "timeout" = "human"): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    this.emit({ kind: "permission_resolved", agent: "?", requestId, optionId, by, ts: now() });
    p.resolve({ optionId });
    return true;
  }

  pendingDecisions(): { requestId: string }[] {
    return [...this.pending.keys()].map((requestId) => ({ requestId }));
  }
}

function deriveConfigOption(session: unknown, category: "mode" | "model" | "effort"): { configId: string; current: string; available: Array<{ id: string; name: string; description?: string }> } | undefined {
  const options = (session as any)?.configOptions;
  if (!Array.isArray(options)) return undefined;
  const configOption = options.find((o: any) => o?.category === category);
  if (!configOption) return undefined;
  const available = Array.isArray(configOption.options)
    ? configOption.options
        .map((o: any) => {
          const id = String(o?.value ?? "");
          if (!id) return undefined;
          const item: { id: string; name: string; description?: string } = { id, name: String(o?.name ?? o?.value ?? id) };
          if (o?.description !== undefined) item.description = String(o.description);
          return item;
        })
        .filter(Boolean)
    : [];
  const current = String(configOption.currentValue ?? available[0]?.id ?? "");
  return { configId: String(configOption.id ?? category), current, available: available as Array<{ id: string; name: string; description?: string }> };
}

function deriveStandardModels(session: unknown): { current: string; available: Array<{ id: string; name: string }> } | undefined {
  const models = (session as any)?.models;
  const available = Array.isArray(models?.availableModels)
    ? models.availableModels
        .map((m: any) => {
          const id = String(m?.modelId ?? "");
          if (!id) return undefined;
          return { id, name: String(m?.name ?? m?.modelId ?? id) };
        })
        .filter(Boolean)
    : [];
  if (!available.length) return undefined;
  const current = String(models?.currentModelId ?? available[0]?.id ?? "");
  return { current, available: available as Array<{ id: string; name: string }> };
}

function resolveDesiredModel(
  agent: AgentConfig,
  desiredModel: string,
  standardModel: { available: Array<{ id: string }> } | undefined,
  configModel: { available: Array<{ id: string }> } | undefined,
): string | undefined {
  const standardIds = new Set((standardModel?.available ?? []).map((m) => m.id));
  const configIds = new Set((configModel?.available ?? []).map((m) => m.id));
  if (agent.harness === "codex") {
    const combined = `${desiredModel}/${agent.effort ?? "low"}`;
    if (standardIds.has(combined)) return combined;
  }
  if (standardIds.has(desiredModel)) return desiredModel;
  if (configIds.has(desiredModel)) return desiredModel;
  return undefined;
}

function displayModelCurrent(
  appliedModel: string | undefined,
  fallback: string,
  available: Array<{ id: string }>,
): string {
  const ids = new Set(available.map((m) => m.id));
  if (appliedModel && ids.has(appliedModel)) return appliedModel;
  const baseModel = appliedModel?.split("/")[0];
  if (baseModel && ids.has(baseModel)) return baseModel;
  return fallback;
}

function edgeKey(from: AgentId, to: AgentId): string {
  return `${from}\u0000${to}`;
}
