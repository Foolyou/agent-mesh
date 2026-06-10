// WebGateway: the testable core of the WebUI server. It wraps a MeshManager (and an
// optional MasterAgent), folds their event streams into authoritative state — including
// aggregated per-agent transcripts — and fans out a snapshot + deltas to subscribers.
// It has no HTTP/WS dependency: server.ts adapts it to Bun.serve, tests drive it directly.
import { reduceTranscript } from "./transcript";
import { now } from "../acp/types";
import { resolve } from "node:path";
import type { AgentConfig, MeshConfig, MeshEdge, MeshEvent, AgentId, AgentStatus, AgentActivity, AgentTurn, PromptImageRef, ThinkingEffort } from "../acp/types";
import type { StartMeshOptions } from "../mesh-manager";
import { readUpload, storeUploads, uploadPath, type UploadFileLike } from "./uploads";
import { AgentFileError, resolveAgentFile } from "./agent-files";
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
  MasterStatus,
  PerMeshState,
  QueueItem,
  QueueSummary,
  TranscriptItem,
  TranscriptOp,
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
  steerAgent(name: string, agentId: string, text: string, images?: PromptImageRef[]): void;
  resolvePermission(name: string, requestId: string, optionId: string): void;
  setMode(name: string, agentId: string, modeId: string): Promise<void>;
  setModel(name: string, agentId: string, modelId: string): Promise<void>;
  setAgentEffort(name: string, agentId: string, effort?: ThinkingEffort): Promise<void>;
  addEdge(name: string, edge: MeshEdge): Promise<void>;
  addAgent(name: string, agent: AgentConfig, edges?: MeshEdge[]): Promise<void>;
  interruptAgent(name: string, agentId: string): void;
  wakeAgent(name: string, agentId: string): void;
  newAgentSession(name: string, agentId: string): Promise<void>;
  newAllSessions(name: string): Promise<void>;
  defineMesh(config: MeshConfig): Promise<void>;
  deleteMesh(name: string): Promise<void>;
  loadDefinitions(): Promise<void>;
  stopAll(): Promise<void>;
}

/** The MasterAgent surface the gateway depends on. */
export interface MasterLike {
  on(l: (u: any) => void): () => void;
  prompt(text: string, images?: PromptImageRef[]): Promise<unknown>;
  cancel(): void;
  get busy(): boolean;
}

const CAP = 500; // ring-buffer cap for activity / mail / history
const TR_CAP = 1000; // per-conversation transcript cap
const QUEUE_ITEM_CAP = 50; // keep queue WS payload bounded; count remains authoritative

function cap<T>(arr: T[], n: number): T[] {
  return arr.length > n ? arr.slice(arr.length - n) : arr;
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
  private uidc = 0;
  private unsubMgr?: () => void;
  private unsubMaster?: () => void;

  constructor(
    private manager: ManagerLike,
    private master?: MasterLike,
    private opts: { root?: string; appVersion?: string } = {},
  ) {
    this.state = {
      appVersion: opts.appVersion ?? defaultAppVersion(),
      meshes: [],
      master: { status: master ? "starting" : "absent", working: false, transcript: [], capabilities: { image: false } },
      perMesh: {},
    };
    this.refreshMeshes();
    this.unsubMgr = manager.on((name, e) => this.ingest(name, e));
    if (master) this.unsubMaster = master.on((u) => this.ingestMaster(u));
  }

  dispose(): void {
    this.unsubMgr?.();
    this.unsubMaster?.();
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
  private broadcastOp(conv: ConvRef, op: TranscriptOp): void {
    if (op.op === "upsert") this.broadcast({ t: "transcript.upsert", conv, item: op.item });
    else this.broadcast({ t: "transcript.patch", conv, id: op.id, patch: op.patch });
  }

  /** A fresh, structurally-cloned copy of the full state. */
  snapshot(): GatewayState {
    this.refreshMeshes();
    for (const m of this.state.meshes) this.ensureMesh(m.name);
    this.state.appVersion = this.opts.appVersion ?? this.state.appVersion ?? defaultAppVersion();
    return structuredClone(this.state);
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
      pm = { config, transcripts: {}, activity: [], mail: [], pending: [], history: [], modes: {}, models: {}, capabilities: {}, queues: {} };
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
  private act(kind: ActivityEntry["kind"], text: string, ts: string): ActivityEntry {
    return { id: this.uid(), ts, kind, text };
  }
  private foldConv(conv: ConvRef, update: any, ts: string): void {
    if (conv.scope === "master") {
      const r = reduceTranscript(this.state.master.transcript, update, ts);
      this.state.master.transcript = cap(r.items, TR_CAP);
      for (const op of r.ops) this.broadcastOp(conv, op);
      return;
    }
    const pm = this.ensureMesh(conv.mesh);
    const items = pm.transcripts[conv.agent] ?? [];
    const r = reduceTranscript(items, update, ts);
    pm.transcripts[conv.agent] = cap(r.items, TR_CAP);
    for (const op of r.ops) this.broadcastOp(conv, op);
  }
  private foldStartedTurn(name: string, turn: AgentTurn, ts: string): void {
    const conv = { scope: "agent" as const, mesh: name, agent: turn.agent };
    if (turn.source === "mail" || (turn.source === "steer" && turn.from && turn.from !== "operator")) {
      this.foldConv(conv, { sessionUpdate: "__mail__", from: turn.from ?? "unknown", to: turn.to ?? turn.agent, body: turn.text }, ts);
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
        if (u && u.sessionUpdate === "current_mode_update" && u.currentModeId) {
          const am = pm.modes[e.agent];
          if (am && am.current !== u.currentModeId) {
            am.current = u.currentModeId;
            this.broadcast({ t: "agent.modes", name, agent: e.agent, current: am.current, available: am.available });
          }
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
      case "agent_capabilities": {
        pm.capabilities[e.agent] = { image: e.image };
        this.broadcast({ t: "agent.capabilities", name, agent: e.agent, image: e.image });
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
        } else {
          const idx = q.findIndex((turn) => turn.id === e.turn.id);
          if (idx >= 0) q.splice(idx, 1);
          this.publishQueue(name, e.turn.agent);
          this.foldStartedTurn(name, e.turn, e.ts || now());
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

  private ingestMaster(u: any): void {
    this.foldConv({ scope: "master" }, u, now());
  }

  // ── Commands (delegate to manager / master; echo user turns) ───────────────────
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
  async setEffort(name: string, agentId: string, effort?: ThinkingEffort): Promise<void> {
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
  async newAgentSession(name: string, agentId: string): Promise<void> {
    await this.manager.newAgentSession(name, agentId);
    this.refreshMeshes();
  }
  async newAllSessions(name: string): Promise<void> {
    await this.manager.newAllSessions(name);
    this.refreshMeshes();
  }
  async promptMaster(text: string, images: PromptImageRef[] = []): Promise<void> {
    if (!this.master) throw new Error("master agent is not configured");
    const refs = images.map((i) => this.withBucket("master", i));
    this.foldConv({ scope: "master" }, { sessionUpdate: "user_message_chunk", content: { text }, images: refs.map(publicImageRef) }, now());
    this.state.master.working = true;
    this.broadcast({ t: "master.status", status: this.state.master.status, working: true });
    try {
      await this.master.prompt(text, refs);
    } finally {
      this.state.master.working = false;
      this.broadcast({ t: "master.status", status: this.state.master.status, working: false });
    }
  }

  interruptMaster(): void {
    if (!this.master) return;
    this.master.cancel();
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

  async serveAgentFile(agentName: string, relPath: string): Promise<Response> {
    const agent = this.findRunningAgent(agentName);
    if (!agent) throw new AgentFileError("enotfound", "agent file not found");
    const cwd = resolve(process.cwd(), agent.project);
    const file = await resolveAgentFile(cwd, relPath);
    const body = new Uint8Array(file.bytes.byteLength);
    body.set(file.bytes);
    return new Response(body, {
      headers: {
        "content-type": file.contentType,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
        "cache-control": "private, max-age=60",
        "content-disposition": `inline; filename="${relPath.split("/").pop()?.replace(/"/g, "") || "file"}"`,
      },
    });
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
    if (bucket === "master") return;
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

  // ── Master lifecycle status (set by main.ts around master.start/stop) ──────────
  setMasterStatus(status: MasterStatus): void {
    this.state.master.status = status;
    this.broadcast({ t: "master.status", status });
  }

  setMasterCapabilities(caps: { image: boolean }): void {
    this.state.master.capabilities = caps;
    this.broadcast({ t: "master.capabilities", image: caps.image });
  }
}
