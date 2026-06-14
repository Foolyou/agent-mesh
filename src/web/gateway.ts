// WebGateway: the testable core of the WebUI server. It wraps a MeshManager (and an
// optional MeshAssistant), folds their event streams into authoritative state — including
// aggregated per-agent transcripts — and fans out a snapshot + deltas to subscribers.
// It has no HTTP/WS dependency: server.ts adapts it to Bun.serve, tests drive it directly.
import { reduceTranscript } from "./transcript";
import { now } from "../acp/types";
import { resolve } from "node:path";
import type { AgentConfig, MeshConfig, MeshEdge, MeshEvent, AgentId, AgentStatus, AgentActivity, AgentTurn, PromptImageRef, HarnessId } from "../acp/types";
import type { StartMeshOptions } from "../mesh-manager";
import type { RespawnMode, RespawnResult } from "../control-plane";
import { readUpload, storeUploads, uploadPath, type UploadFileLike } from "./uploads";
import { AgentFileError, resolveAgentFile } from "./agent-files";
import { resolveArtifactFile } from "./artifacts";
import { defaultAppVersion } from "./version";
import type {
  GatewayState,
  ServerMsg,
  MeshSummary,
  MeshStatus,
  ConvRef,
  ActivityEntry,
  PermissionReq,
  ResolvedPermission,
  MailEntry,
  AssistantStatus,
  PerMeshState,
  QueueItem,
  QueueSummary,
  TranscriptItem,
  TranscriptOp,
  AgentUsage,
  TranscriptSnapshot,
} from "./types";

/** The MeshManager surface the gateway depends on (structural — tests use a fake). */
export interface ManagerLike {
  on(l: (name: string, e: MeshEvent) => void): () => void;
  listMeshes(): { name: string; defined: boolean; status: MeshStatus }[];
  configOf(name: string): MeshConfig;
  routerOf(name: string): string;
  startMesh(name: string, opts?: StartMeshOptions): Promise<void>;
  stopMesh(name: string): Promise<void>;
  promptRouter(name: string, text: string, images?: PromptImageRef[]): Promise<void>;
  promptAgent(name: string, agentId: string, text: string, images?: PromptImageRef[]): void;
  removeQueuedTurn(name: string, agentId: string, turnId: string): void;
  steerAgent(name: string, agentId: string, text: string, images?: PromptImageRef[]): void;
  resolvePermission(name: string, requestId: string, optionId: string): void;
  setMode(name: string, agentId: string, modeId: string): Promise<void>;
  setModel(name: string, agentId: string, modelId: string): Promise<void>;
  setAgentEffort(name: string, agentId: string, effort?: string): Promise<void>;
  addEdge(name: string, edge: MeshEdge): Promise<void>;
  addAgent(name: string, agent: AgentConfig, edges?: MeshEdge[]): Promise<void>;
  interruptAgent(name: string, agentId: string): void;
  wakeAgent(name: string, agentId: string): void;
  stopAgent(name: string, agentId: string): void;
  newAgentSession(name: string, agentId: string): Promise<void>;
  respawnAgent(name: string, agentId: string, mode: RespawnMode): Promise<RespawnResult>;
  newAllSessions(name: string): Promise<void>;
  defineMesh(config: MeshConfig): Promise<void>;
  deleteMesh(name: string): Promise<void>;
  loadDefinitions(): Promise<void>;
  stopAll(): Promise<void>;
  listResolvedHarnesses?(): { mesh: string; agentId: string; harnessId: HarnessId; version?: string; path?: string; spawnedAt: string }[];
}

/** The MeshAssistant surface the gateway depends on. */
export interface AssistantLike {
  on(l: (u: any) => void): () => void;
  prompt(text: string, images?: PromptImageRef[]): Promise<unknown>;
  cancel(): void;
  get busy(): boolean;
}

const CAP = 500; // ring-buffer cap for activity / mail / history
const TR_CAP = 1000; // per-conversation transcript cap
const QUEUE_ITEM_CAP = 50; // keep queue WS payload bounded; count remains authoritative
export const MAX_SNAPSHOT_TRANSCRIPT_ITEMS = 0;
export const DEFAULT_BACKFILL_LIMIT = 100;
export const MAX_BACKFILL_LIMIT = 500;

function cap<T>(arr: T[], n: number): T[] {
  return arr.length > n ? arr.slice(arr.length - n) : arr;
}

function transcriptSnapshot(items: TranscriptItem[], hasMore = false): TranscriptSnapshot {
  const first = items[0];
  return first ? { items, hasMore, oldestSeq: first.id } : { items, hasMore };
}

function configOptionOf(update: any): { category: "mode" | "model" | "effort"; configId: string; current: string; available: Array<{ id: string; name: string; description?: string }> } | undefined {
  if (!update || (update.sessionUpdate !== "config_option_update" && update.sessionUpdate !== "session_config_update")) return undefined;
  const option = update.option ?? update.configOption ?? update.config_option;
  const category = option?.category;
  if (category !== "mode" && category !== "model" && category !== "effort") return undefined;
  const available = Array.isArray(option.options)
    ? option.options
        .map((o: any) => {
          const id = String(o?.value ?? o?.id ?? "");
          if (!id) return undefined;
          const item: { id: string; name: string; description?: string } = { id, name: String(o?.name ?? o?.value ?? o?.id ?? id) };
          if (o?.description !== undefined) item.description = String(o.description);
          return item;
        })
        .filter(Boolean)
    : [];
  const current = String(option.currentValue ?? option.current_value ?? option.current ?? available[0]?.id ?? "");
  if (!current && !available.length) return undefined;
  return { category, configId: String(option.id ?? category), current, available: available as Array<{ id: string; name: string; description?: string }> };
}

function usageOf(update: any, ts: string): AgentUsage | undefined {
  if (!update || update.sessionUpdate !== "usage_update") return undefined;
  const used = Number(update.used ?? update.context?.used);
  const size = Number(update.size ?? update.context?.size);
  const costRaw = update.cost ?? update.totalCost ?? update.total_cost;
  const cost = costRaw === undefined ? undefined : Number(costRaw);
  const usage: AgentUsage = { ts };
  if (Number.isFinite(used)) usage.used = used;
  if (Number.isFinite(size)) usage.size = size;
  if (cost !== undefined && Number.isFinite(cost)) usage.cost = cost;
  return usage.used !== undefined || usage.size !== undefined || usage.cost !== undefined ? usage : undefined;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Project an image ref to the fields safe to broadcast/persist in a transcript: the absolute
 *  on-disk `path` and internal `bucket` stay server-side (used only at the ACP boundary to read
 *  the bytes) and must never reach WS clients. Clients render the thumbnail from `url`. */
function publicImageRef(i: PromptImageRef): PromptImageRef {
  return { id: i.id, mimeType: i.mimeType, name: i.name, url: i.url };
}

export class WebGateway {
  private state: GatewayState;
  private listeners = new Set<(m: ServerMsg) => void>();
  private agStatus = new Map<string, Map<AgentId, AgentStatus>>();
  private agActivity = new Map<string, Map<AgentId, AgentActivity>>();
  private queues = new Map<string, Map<AgentId, AgentTurn[]>>();
  private initialReplay = new Set<string>();
  private uidc = 0;
  private unsubMgr?: () => void;
  private unsubAssistant?: () => void;

  constructor(
    private manager: ManagerLike,
    private assistant?: AssistantLike,
    private opts: { root?: string; appVersion?: string } = {},
  ) {
    this.state = {
      appVersion: opts.appVersion ?? defaultAppVersion(),
      meshes: [],
      assistant: { status: assistant ? "starting" : "absent", working: false, transcript: [], capabilities: { image: false } },
      perMesh: {},
    };
    this.refreshMeshes();
    this.unsubMgr = manager.on((name, e) => this.ingest(name, e));
    if (assistant) this.unsubAssistant = assistant.on((u) => this.ingestAssistant(u));
  }

  dispose(): void {
    this.unsubMgr?.();
    this.unsubAssistant?.();
  }

  // ── Fan-out ────────────────────────────────────────────────────────────────
  subscribe(listener: (m: ServerMsg) => void): () => void {
    this.listeners.add(listener);
    listener({ t: "snapshot", state: this.snapshot() });
    return () => this.listeners.delete(listener);
  }
  private broadcast(m: ServerMsg): void {
    for (const l of this.listeners) l(m);
  }
  broadcastHarnessesChanged(harnessId: HarnessId): void {
    this.broadcast({ t: "harnesses-changed", harnessId });
  }

  runningAgentsUsingOldVersion(id: HarnessId, latest?: string): string[] {
    if (!latest) return [];
    const resolved = this.manager.listResolvedHarnesses?.() ?? [];
    return resolved
      .filter((r) => r.harnessId === id && r.version && compareSemver(r.version, latest) < 0)
      .map((r) => `${r.mesh}/${r.agentId}`);
  }
  private broadcastOp(conv: ConvRef, op: TranscriptOp): void {
    if (op.op === "upsert") this.broadcast({ t: "transcript.upsert", conv, item: op.item });
    else this.broadcast({ t: "transcript.patch", conv, id: op.id, patch: op.patch });
  }
  private replayKey(mesh: string, agent: AgentId): string {
    return `${mesh}:${agent}`;
  }
  beginInitialReplay(mesh: string, agent: AgentId): void {
    this.initialReplay.add(this.replayKey(mesh, agent));
  }
  endInitialReplay(mesh: string, agent: AgentId): void {
    this.initialReplay.delete(this.replayKey(mesh, agent));
  }

  /** A fresh, structurally-cloned copy of the full state. */
  snapshot(): GatewayState {
    this.refreshMeshes();
    for (const m of this.state.meshes) this.ensureMesh(m.name);
    this.state.appVersion = this.opts.appVersion ?? this.state.appVersion ?? defaultAppVersion();
    const snapshot = structuredClone(this.state);
    for (const m of snapshot.meshes) {
      const pm = snapshot.perMesh[m.name];
      if (!pm) continue;
      let config: MeshConfig;
      try {
        config = this.manager.configOf(m.name);
      } catch {
        continue;
      }
      for (const agent of config.agents) {
        const existing = pm.transcripts[agent.id];
        pm.transcripts[agent.id] = transcriptSnapshot([], existing ? existing.items.length > 0 || existing.hasMore : true);
      }
    }
    return snapshot;
  }

  getOlderTranscriptItems(mesh: string, agent: AgentId, beforeId: string | undefined, limit: number): { items: TranscriptItem[]; hasMore: boolean } | null {
    let config: MeshConfig;
    try {
      config = this.manager.configOf(mesh);
    } catch {
      return null;
    }
    if (!config.agents.some((a) => a.id === agent)) return null;
    const transcript = this.state.perMesh[mesh]?.transcripts[agent];
    const all = transcript?.items ?? [];
    const beforeIndex = beforeId ? all.findIndex((item) => item.id === beforeId) : all.length;
    if (beforeIndex < 0) return { items: [], hasMore: false };
    const start = Math.max(0, beforeIndex - limit);
    return {
      items: structuredClone(all.slice(start, beforeIndex)),
      hasMore: start > 0,
    };
  }

  // ── Mesh summary ─────────────────────────────────────────────────────────────
  private computeMeshes(): MeshSummary[] {
    return this.manager.listMeshes().map((m) => {
      let config: MeshConfig;
      try {
        config = this.manager.configOf(m.name);
      } catch {
        config = { name: m.name, agents: [], edges: [] };
      }
      let router = "";
      try {
        router = this.manager.routerOf(m.name);
      } catch {
        router = config.agents.find((a) => a.role === "router")?.id ?? "";
      }
      const live = m.status === "running" || m.status === "starting";
      const tracked = this.agStatus.get(m.name);
      const activity = this.agActivity.get(m.name);
      const pm = this.state.perMesh[m.name];
      return {
        name: m.name,
        defined: m.defined,
        status: m.status,
        router,
        agents: config.agents.map((a) => {
          const status = (live ? tracked?.get(a.id) : undefined) ?? (live ? "spawning" : "dead");
          return {
            id: a.id,
            harness: a.harness,
            role: a.role,
            status,
            activity: status === "dead" ? "idle" : ((live ? activity?.get(a.id) : undefined) ?? "idle"),
            effort: a.effort,
            opencodePermission: a.opencodePermission,
            lazy: a.lazy,
            model: pm?.models?.[a.id],
          };
        }),
        edges: config.edges,
      };
    });
  }
  private refreshMeshes(): void {
    const next = this.computeMeshes();
    if (JSON.stringify(next) !== JSON.stringify(this.state.meshes)) {
      this.state.meshes = next;
      this.broadcast({ t: "mesh.list", meshes: next });
    }
  }

  // ── State helpers ────────────────────────────────────────────────────────────
  private uid(): string {
    return `e${this.uidc++}`;
  }
  private ensureMesh(name: string): PerMeshState {
    let pm = this.state.perMesh[name];
    if (!pm) {
      let config: MeshConfig;
      try {
        config = this.manager.configOf(name);
      } catch {
        config = { name, agents: [], edges: [] };
      }
      pm = { config, transcripts: {}, activity: [], mail: [], pending: [], history: [], modes: {}, models: {}, efforts: {}, capabilities: {}, usage: {}, health: {}, selfAwareness: {}, queues: {} };
      this.state.perMesh[name] = pm;
    }
    return pm;
  }
  private queueFor(name: string, agent: AgentId): AgentTurn[] {
    let perMesh = this.queues.get(name);
    if (!perMesh) {
      perMesh = new Map();
      this.queues.set(name, perMesh);
    }
    const q = perMesh.get(agent) ?? [];
    perMesh.set(agent, q);
    return q;
  }
  private queueSummary(name: string, agent: AgentId): QueueSummary {
    const q = this.queueFor(name, agent);
    const latest = q.reduce<AgentTurn | undefined>((acc, turn) => (!acc || turn.ts >= acc.ts ? turn : acc), undefined);
    const tail = q.length > QUEUE_ITEM_CAP ? q.slice(q.length - QUEUE_ITEM_CAP) : q;
    const visible = latest && !tail.some((turn) => turn.id === latest.id) ? [latest, ...tail.slice(1)] : tail;
    const items: QueueItem[] = visible.map((turn) => ({
      id: turn.id,
      source: turn.source,
      preview: turn.preview,
      ts: turn.ts,
      from: turn.from,
      to: turn.to,
    }));
    return { count: q.length, latestId: latest?.id, latestPreview: latest?.preview, items };
  }
  private addQueuedTurn(q: AgentTurn[], turn: AgentTurn): void {
    if (q.some((queued) => queued.id === turn.id)) return;
    if (turn.source !== "steer") {
      q.push(turn);
      return;
    }
    const insertAt = q.findIndex((queued) => queued.source !== "steer");
    if (insertAt >= 0) q.splice(insertAt, 0, turn);
    else q.push(turn);
  }
  private publishQueue(name: string, agent: AgentId): void {
    const pm = this.ensureMesh(name);
    const summary = this.queueSummary(name, agent);
    pm.queues = { ...pm.queues, [agent]: summary };
    this.broadcast({ t: "agent.queue", name, agent, summary });
  }
  private publishSelfAwareness(name: string, agent: AgentId): void {
    const pm = this.ensureMesh(name);
    this.broadcast({ t: "agent.selfAwareness", name, agent, selfAwareness: pm.selfAwareness[agent] ?? {} });
  }
  private act(kind: ActivityEntry["kind"], text: string, ts: string): ActivityEntry {
    return { id: this.uid(), ts, kind, text };
  }
  private foldConv(conv: ConvRef, update: any, ts: string): void {
    if (conv.scope === "assistant") {
      const r = reduceTranscript(this.state.assistant.transcript, update, ts);
      this.state.assistant.transcript = cap(r.items, TR_CAP);
      for (const op of r.ops) this.broadcastOp(conv, op);
      return;
    }
    const pm = this.ensureMesh(conv.mesh);
    const transcript = pm.transcripts[conv.agent] ?? transcriptSnapshot([]);
    const items = transcript.items;
    const r = reduceTranscript(items, update, ts);
    pm.transcripts[conv.agent] = transcriptSnapshot(cap(r.items, TR_CAP), false);
    if (this.initialReplay.has(this.replayKey(conv.mesh, conv.agent))) return;
    for (const op of r.ops) this.broadcastOp(conv, op);
  }
  private foldStartedTurn(name: string, turn: AgentTurn, ts: string): void {
    const conv = { scope: "agent" as const, mesh: name, agent: turn.agent };
    if (turn.source === "mail" || (turn.source === "steer" && turn.from && turn.from !== "operator")) {
      this.foldConv(conv, { sessionUpdate: "__mail__", from: turn.from ?? "unknown", to: turn.to ?? turn.agent, body: turn.text }, ts);
      return;
    }
    if (turn.source === "system") {
      this.foldConv(conv, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[${turn.preview}]` } }, ts);
      return;
    }
    this.foldConv(conv, { sessionUpdate: "user_message_chunk", content: { text: turn.text }, images: turn.images }, ts);
  }

  // ── Event ingestion ──────────────────────────────────────────────────────────
  private ingest(name: string, e: MeshEvent): void {
    const pm = this.ensureMesh(name);
    switch (e.kind) {
      case "update": {
        // A mode change the agent reports mid-session (operator- or self-initiated) rides
        // the normal session-update stream; keep the picker's selection in sync with it.
        const u = e.update as any;
        const usage = usageOf(u, e.ts || now());
        if (usage) {
          pm.usage[e.agent] = usage;
          this.broadcast({ t: "agent.usage", name, agent: e.agent, usage });
          break;
        }
        if (u && u.sessionUpdate === "current_mode_update" && u.currentModeId) {
          const am = pm.modes[e.agent];
          if (am && am.current !== u.currentModeId) {
            am.current = u.currentModeId;
            this.broadcast({ t: "agent.modes", name, agent: e.agent, current: am.current, available: am.available });
          }
        }
        const configOption = configOptionOf(u);
        if (configOption?.category === "mode") {
          pm.modes[e.agent] = { current: configOption.current, available: configOption.available };
          this.broadcast({ t: "agent.modes", name, agent: e.agent, current: configOption.current, available: configOption.available });
        } else if (configOption?.category === "model") {
          pm.models[e.agent] = { current: configOption.current, available: configOption.available };
          this.broadcast({ t: "agent.models", name, agent: e.agent, current: configOption.current, available: configOption.available });
        } else if (configOption?.category === "effort") {
          pm.efforts[e.agent] = { configId: configOption.configId, current: configOption.current, available: configOption.available };
          this.broadcast({ t: "agent.efforts", name, agent: e.agent, configId: configOption.configId, current: configOption.current, available: configOption.available });
        }
        this.foldConv({ scope: "agent", mesh: name, agent: e.agent }, e.update, e.ts || now());
        break;
      }
      case "agent_modes": {
        pm.modes[e.agent] = { current: e.current, available: e.available };
        this.broadcast({ t: "agent.modes", name, agent: e.agent, current: e.current, available: e.available });
        break;
      }
      case "agent_models": {
        pm.models[e.agent] = { current: e.current, available: e.available };
        this.broadcast({ t: "agent.models", name, agent: e.agent, current: e.current, available: e.available });
        break;
      }
      case "agent_efforts": {
        pm.efforts[e.agent] = { configId: e.configId, current: e.current, available: e.available };
        this.broadcast({ t: "agent.efforts", name, agent: e.agent, configId: e.configId, current: e.current, available: e.available });
        break;
      }
      case "agent_capabilities": {
        pm.capabilities[e.agent] = { image: e.image };
        this.broadcast({ t: "agent.capabilities", name, agent: e.agent, image: e.image });
        break;
      }
      case "agent_health_signal": {
        const health = { signal: e.signal, detail: e.detail, turn: e.turn, ts: e.ts };
        pm.health[e.agent] = health;
        this.broadcast({ t: "agent.health", name, agent: e.agent, health });
        break;
      }
      case "compact_started":
      case "compact_completed":
      case "compact_failed": {
        const status = e.kind === "compact_failed" ? "failed" : e.kind === "compact_completed" ? "completed" : "started";
        const ts = typeof e.ts === "number" ? new Date(e.ts).toISOString() : e.ts;
        this.foldConv({ scope: "agent", mesh: name, agent: e.agent }, {
          sessionUpdate: "__compact__",
          status,
          reason: e.kind === "compact_started" ? e.reason : undefined,
          error: e.kind === "compact_failed" ? e.error : undefined,
        }, ts);
        pm.selfAwareness[e.agent] = { ...(pm.selfAwareness[e.agent] ?? {}), lastCompactAt: e.kind === "compact_started" ? e.ts : (pm.selfAwareness[e.agent]?.lastCompactAt ?? null) };
        const text = e.kind === "compact_failed" ? `${e.agent} compact failed: ${e.error}` : `${e.agent} compact ${status}`;
        const entry = this.act("compact", text, ts);
        pm.activity.push(entry);
        pm.activity = cap(pm.activity, CAP);
        this.broadcast({ t: "activity", name, entry });
        this.publishSelfAwareness(name, e.agent);
        break;
      }
      case "near_context_limit_no_compact": {
        const ts = typeof e.ts === "number" ? new Date(e.ts).toISOString() : e.ts;
        pm.selfAwareness[e.agent] = { ...(pm.selfAwareness[e.agent] ?? {}), nearLimit: { usagePercent: e.usagePercent, ts: e.ts }, lastNearLimitWarnedAt: e.ts };
        const entry = this.act("warning", `${e.agent} context near limit (${Math.round(e.usagePercent * 100)}%), /compact unavailable`, ts);
        pm.activity.push(entry);
        pm.activity = cap(pm.activity, CAP);
        this.broadcast({ t: "activity", name, entry });
        this.publishSelfAwareness(name, e.agent);
        break;
      }
      case "replay_started": {
        this.beginInitialReplay(name, e.agent);
        break;
      }
      case "replay_finished": {
        this.endInitialReplay(name, e.agent);
        break;
      }
      case "silent_task_complete": {
        const current = pm.selfAwareness[e.agent]?.silentTaskCompletes ?? { count: 0, lastAt: null };
        pm.selfAwareness[e.agent] = { ...(pm.selfAwareness[e.agent] ?? {}), silentTaskCompletes: { count: current.count + 1, lastAt: e.ts } };
        const ts = new Date(e.ts).toISOString();
        const entry = this.act("warning", `${e.agent} silent stop ×${current.count + 1}`, ts);
        pm.activity.push(entry);
        pm.activity = cap(pm.activity, CAP);
        this.broadcast({ t: "activity", name, entry });
        this.publishSelfAwareness(name, e.agent);
        break;
      }
      case "agent_turn_health": {
        // Non-fatal "agent is quiet" hint from the turn watchdog — surface it in the
        // activity feed so the operator knows the agent is working (likely long
        // reasoning/compaction), not dead. The turn is never cancelled or killed.
        const entry = this.act("log", `⚠️ ${e.agent} ${e.detail}`, e.ts);
        pm.activity.push(entry);
        pm.activity = cap(pm.activity, CAP);
        this.broadcast({ t: "activity", name, entry });
        break;
      }
      case "steer": {
        const from = e.from === "operator" ? "operator" : e.from;
        const entry = this.act("steer", `${from} ⇢ ${e.to}: ${e.body}`, e.ts);
        pm.activity.push(entry);
        pm.activity = cap(pm.activity, CAP);
        this.broadcast({ t: "activity", name, entry });
        break;
      }
      case "permission": {
        const req: PermissionReq = {
          requestId: e.requestId,
          agent: e.agent,
          question: e.question,
          options: e.options,
          ts: e.ts,
        };
        pm.pending.push(req);
        this.broadcast({ t: "permission.add", name, req });
        break;
      }
      case "permission_resolved": {
        pm.pending = pm.pending.filter((p) => p.requestId !== e.requestId);
        const resolved: ResolvedPermission = {
          requestId: e.requestId,
          agent: e.agent,
          optionId: e.optionId,
          by: e.by,
          ts: e.ts,
        };
        pm.history.push(resolved);
        pm.history = cap(pm.history, CAP);
        const entry = this.act("permission_resolved", `${e.agent} · ${e.requestId.slice(0, 8)} → ${e.optionId} (${e.by})`, e.ts);
        pm.activity.push(entry);
        pm.activity = cap(pm.activity, CAP);
        this.broadcast({ t: "permission.remove", name, resolved });
        this.broadcast({ t: "activity", name, entry });
        break;
      }
      case "agent_turn": {
        const q = this.queueFor(name, e.turn.agent);
        if (e.phase === "queued") {
          this.addQueuedTurn(q, e.turn);
          this.publishQueue(name, e.turn.agent);
        } else if (e.phase === "started") {
          const idx = q.findIndex((turn) => turn.id === e.turn.id);
          if (idx >= 0) q.splice(idx, 1);
          this.publishQueue(name, e.turn.agent);
          this.foldStartedTurn(name, e.turn, e.ts || now());
        } else if (e.phase === "consumed") {
          const idx = q.findIndex((turn) => turn.id === e.turn.id);
          if (idx >= 0) q.splice(idx, 1);
          this.publishQueue(name, e.turn.agent);
          this.foldStartedTurn(name, e.turn, e.ts || now());
        } else {
          const idx = q.findIndex((turn) => turn.id === e.turn.id);
          if (idx >= 0) q.splice(idx, 1);
          this.publishQueue(name, e.turn.agent);
        }
        break;
      }
      case "mail": {
        // Durable-id mail can be replayed by snapshot on every reattach; ingest it once.
        if (e.id && pm.mail.some((entry) => entry.id === e.id)) break;
        const mailEntry: MailEntry = { id: e.id ?? this.uid(), ts: e.ts, from: e.from, to: e.to, body: e.body };
        pm.mail.push(mailEntry);
        pm.mail = cap(pm.mail, CAP);
        const entry = this.act("mail", `${e.from} → ${e.to}: ${e.body.slice(0, 80)}`, e.ts);
        pm.activity.push(entry);
        pm.activity = cap(pm.activity, CAP);
        this.broadcast({ t: "mail", name, entry: mailEntry });
        this.broadcast({ t: "activity", name, entry });
        break;
      }
      case "attachment_published": {
        // Fold into the publishing agent's transcript as a first-class attachment card.
        // The stable id (agent|path|ts) makes the fold idempotent: snapshotEvents() replays
        // this on every backend reattach, and the reducer replaces-by-id rather than stacking.
        const id = `att:${e.agent}|${e.path}|${e.ts}`;
        this.foldConv({ scope: "agent", mesh: name, agent: e.agent }, {
          sessionUpdate: "__attachment__",
          id,
          agent: e.agent,
          path: e.path,
          caption: e.caption,
          name: e.name,
          contentType: e.contentType,
        }, e.ts);
        break;
      }
      case "interrupt": {
        const entry = this.act("interrupt", `${e.from} → ${e.target}${e.reason ? `: ${e.reason}` : ""}`, e.ts);
        pm.activity.push(entry);
        pm.activity = cap(pm.activity, CAP);
        this.broadcast({ t: "activity", name, entry });
        break;
      }
      case "log": {
        const entry = this.act("log", e.text, e.ts);
        pm.activity.push(entry);
        pm.activity = cap(pm.activity, CAP);
        this.broadcast({ t: "activity", name, entry });
        break;
      }
      case "agent_status": {
        let s = this.agStatus.get(name);
        if (!s) {
          s = new Map();
          this.agStatus.set(name, s);
        }
        s.set(e.agent, e.status);
        if (e.status === "dead") {
          const q = this.queueFor(name, e.agent);
          q.splice(0);
          this.publishQueue(name, e.agent);
        }
        this.broadcast({ t: "agent.status", name, agent: e.agent, status: e.status, detail: e.detail });
        break;
      }
      case "agent_activity": {
        let a = this.agActivity.get(name);
        if (!a) {
          a = new Map();
          this.agActivity.set(name, a);
        }
        a.set(e.agent, e.activity);
        this.broadcast({ t: "agent.activity", name, agent: e.agent, activity: e.activity });
        break;
      }
    }
    this.refreshMeshes();
  }

  private ingestAssistant(u: any): void {
    this.foldConv({ scope: "assistant" }, u, now());
  }

  // ── Commands (delegate to manager / assistant; echo user turns) ───────────────────
  async startMesh(name: string, opts?: StartMeshOptions): Promise<void> {
    await this.manager.startMesh(name, opts);
    this.refreshMeshes();
  }
  async stopMesh(name: string): Promise<void> {
    await this.manager.stopMesh(name);
    this.agStatus.delete(name);
    this.agActivity.delete(name);
    this.queues.delete(name);
    const pm = this.state.perMesh[name];
    if (pm) pm.queues = {};
    this.refreshMeshes();
  }
  async reload(): Promise<void> {
    await this.manager.loadDefinitions();
    this.refreshMeshes();
  }
  async defineMesh(config: MeshConfig): Promise<void> {
    await this.manager.defineMesh(config);
    this.refreshMeshes();
  }
  async deleteMesh(name: string): Promise<void> {
    await this.manager.deleteMesh(name);
    delete this.state.perMesh[name];
    this.agStatus.delete(name);
    this.agActivity.delete(name);
    this.queues.delete(name);
    this.refreshMeshes();
  }
  private routerId(name: string): string {
    try {
      return this.manager.routerOf(name);
    } catch {
      return this.manager.configOf(name).agents.find((a) => a.role === "router")?.id ?? "";
    }
  }
  async promptRouter(name: string, text: string, images: PromptImageRef[] = []): Promise<void> {
    const refs = images.map((i) => this.withBucket(name, i));
    await this.manager.promptRouter(name, text, refs);
  }
  promptAgent(name: string, agentId: string, text: string, images: PromptImageRef[] = []): void {
    const refs = images.map((i) => this.withBucket(name, i));
    this.manager.promptAgent(name, agentId, text, refs);
  }
  removeQueuedTurn(name: string, agentId: string, turnId: string): void {
    const q = this.queueFor(name, agentId);
    const turn = q.find((item) => item.id === turnId);
    if (!turn) throw new Error("queued message not found");
    if (!(turn.source === "operator" || (turn.source === "steer" && turn.from === "operator"))) throw new Error("only user queued messages can be removed");
    this.manager.removeQueuedTurn(name, agentId, turnId);
  }
  steerAgent(name: string, agentId: string, text: string, images: PromptImageRef[] = []): void {
    const refs = images.map((i) => this.withBucket(name, i));
    this.manager.steerAgent(name, agentId, text, refs);
  }
  configOf(name: string): MeshConfig {
    return this.manager.configOf(name);
  }
  resolvePermission(name: string, requestId: string, optionId: string): void {
    this.manager.resolvePermission(name, requestId, optionId);
  }
  async setEffort(name: string, agentId: string, effort?: string): Promise<void> {
    await this.manager.setAgentEffort(name, agentId, effort);
    this.refreshMeshes(); // re-broadcast the summary so the picker reflects the new value
  }
  async setMode(name: string, agentId: string, modeId: string): Promise<void> {
    await this.manager.setMode(name, agentId, modeId);
    this.refreshMeshes();
  }
  async setModel(name: string, agentId: string, modelId: string): Promise<void> {
    await this.manager.setModel(name, agentId, modelId);
    this.refreshMeshes();
  }
  async addEdge(name: string, edge: MeshEdge): Promise<void> {
    await this.manager.addEdge(name, edge);
    this.refreshMeshes();
  }
  async addAgent(name: string, agent: AgentConfig, edges: MeshEdge[] = []): Promise<void> {
    await this.manager.addAgent(name, agent, edges);
    this.refreshMeshes();
  }
  interruptAgent(name: string, agentId: string): void {
    this.manager.interruptAgent(name, agentId);
  }
  wakeAgent(name: string, agentId: string): void {
    this.manager.wakeAgent(name, agentId);
  }
  stopAgent(name: string, agentId: string): void {
    this.manager.stopAgent(name, agentId);
  }
  async newAgentSession(name: string, agentId: string): Promise<void> {
    await this.manager.newAgentSession(name, agentId);
    this.refreshMeshes();
  }
  async respawnAgent(name: string, agentId: string, mode: RespawnMode): Promise<RespawnResult> {
    const result = await this.manager.respawnAgent(name, agentId, mode);
    this.refreshMeshes();
    return result;
  }
  async newAllSessions(name: string): Promise<void> {
    await this.manager.newAllSessions(name);
    this.refreshMeshes();
  }
  async promptAssistant(text: string, images: PromptImageRef[] = []): Promise<void> {
    if (!this.assistant) throw new Error("Mesh Assistant is not configured");
    const refs = images.map((i) => this.withBucket("assistant", i));
    this.foldConv({ scope: "assistant" }, { sessionUpdate: "user_message_chunk", content: { text }, images: refs.map(publicImageRef) }, now());
    this.state.assistant.working = true;
    this.broadcast({ t: "assistant.status", status: this.state.assistant.status, working: true });
    try {
      await this.assistant.prompt(text, refs);
    } finally {
      this.state.assistant.working = false;
      this.broadcast({ t: "assistant.status", status: this.state.assistant.status, working: false });
    }
  }

  interruptAssistant(): void {
    if (!this.assistant) return;
    this.assistant.cancel();
  }

  async upload(bucket: string, files: UploadFileLike[]): Promise<PromptImageRef[]> {
    this.validateBucket(bucket);
    if (!this.opts.root) throw new Error("upload storage root is not configured");
    const stored = await storeUploads(this.opts.root, bucket, files);
    return stored.map(({ id, url, mimeType, name }) => ({ id, url, mimeType, name }));
  }

  async serveUpload(bucket: string, id: string): Promise<Response> {
    this.validateBucket(bucket);
    if (!this.opts.root) throw new Error("upload storage root is not configured");
    let file: Awaited<ReturnType<typeof readUpload>>;
    try {
      file = await readUpload(this.opts.root, bucket, id);
    } catch {
      // Missing / malformed id: return a generic 404 rather than letting the Node ENOENT error
      // (which embeds the absolute server path) propagate to the client as a 400 body.
      return new Response("upload not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    // readUpload's declared return type is the generic Uint8Array<ArrayBufferLike>, which the
    // DOM BodyInit type rejects (it wants an ArrayBuffer-backed view). Copy into a fresh
    // ArrayBuffer-backed array so the bytes are a valid Response body without an unsafe cast.
    const body = new Uint8Array(file.bytes.byteLength);
    body.set(file.bytes);
    return new Response(body, {
      headers: {
        "content-type": file.mimeType,
        "x-content-type-options": "nosniff",
        "content-disposition": `inline; filename="${file.name.replace(/"/g, "")}"`,
      },
    });
  }

  async serveAgentArtifact(mesh: string, agentId: string, relPath: string): Promise<Response> {
    if (!this.opts.root) throw new AgentFileError("enotfound", "artifact storage root is not configured");
    let config: MeshConfig;
    try {
      config = this.manager.configOf(mesh);
    } catch {
      throw new AgentFileError("enotfound", "mesh artifact not found");
    }
    if (!config.agents.some((a) => a.id === agentId)) throw new AgentFileError("enotfound", "agent artifact not found");
    const file = await resolveArtifactFile(this.opts.root, mesh, agentId, relPath);
    return responseForServedFile(file.bytes, file.contentType, relPath);
  }

  async serveAgentFile(agentName: string, relPath: string): Promise<Response> {
    const agent = this.findRunningAgent(agentName);
    if (!agent) throw new AgentFileError("enotfound", "agent file not found");
    const cwd = resolve(process.cwd(), agent.project);
    const file = await resolveAgentFile(cwd, relPath);
    return responseForServedFile(file.bytes, file.contentType, relPath);
  }

  private findRunningAgent(agentName: string): AgentConfig | undefined {
    for (const m of this.manager.listMeshes()) {
      if (m.status !== "running" && m.status !== "starting") continue;
      let config: MeshConfig;
      try {
        config = this.manager.configOf(m.name);
      } catch {
        continue;
      }
      const agent = config.agents.find((a) => a.id === agentName);
      if (agent) return agent;
    }
    return undefined;
  }

  private validateBucket(bucket: string): void {
    if (bucket === "assistant") return;
    if (!this.manager.listMeshes().some((m) => m.name === bucket)) throw new Error("unknown upload bucket");
  }

  // The server is the SOLE source of truth for an image's on-disk location. Derive path+url
  // from the (server-chosen) bucket and a *validated* id via uploadPath() — which enforces the
  // id shape and a traversal guard — and ignore any client-supplied path/url/bucket. An invalid
  // id yields no path, so the image is skipped downstream rather than read off arbitrary disk.
  private withBucket(bucket: string, image: PromptImageRef): PromptImageRef {
    let path: string | undefined;
    let url: string | undefined;
    if (this.opts.root) {
      try {
        path = uploadPath(this.opts.root, bucket, image.id);
        url = `/api/uploads/${encodeURIComponent(bucket)}/${encodeURIComponent(image.id)}`;
      } catch {
        path = undefined;
        url = undefined;
      }
    }
    return { id: image.id, mimeType: image.mimeType, name: image.name, bucket, url, path };
  }

  // ── Assistant lifecycle status (set by main.ts around assistant.start/stop) ──────────
  setAssistantStatus(status: AssistantStatus): void {
    this.state.assistant.status = status;
    this.broadcast({ t: "assistant.status", status });
  }

  setAssistantCapabilities(caps: { image: boolean; harness?: HarnessId }): void {
    this.state.assistant.capabilities = caps;
    this.broadcast({ t: "assistant.capabilities", image: caps.image, harness: caps.harness });
  }
}

function responseForServedFile(bytes: Uint8Array, contentType: string, relPath: string): Response {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "cache-control": "private, max-age=60",
      "content-disposition": `inline; filename="${relPath.split("/").pop()?.replace(/"/g, "") || "file"}"`,
    },
  });
}
