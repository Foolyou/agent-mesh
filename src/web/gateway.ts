// WebGateway: the testable core of the WebUI server. It wraps a MeshManager (and an
// optional MasterAgent), folds their event streams into authoritative state — including
// aggregated per-agent transcripts — and fans out a snapshot + deltas to subscribers.
// It has no HTTP/WS dependency: server.ts adapts it to Bun.serve, tests drive it directly.
import { reduceTranscript } from "./transcript";
import { now } from "../acp/types";
import type { MeshConfig, MeshEvent, AgentId, AgentStatus } from "../acp/types";
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
  TranscriptItem,
  TranscriptOp,
} from "./types";

/** The MeshManager surface the gateway depends on (structural — tests use a fake). */
export interface ManagerLike {
  on(l: (name: string, e: MeshEvent) => void): () => void;
  listMeshes(): { name: string; defined: boolean; status: MeshStatus }[];
  configOf(name: string): MeshConfig;
  routerOf(name: string): string;
  startMesh(name: string): Promise<void>;
  stopMesh(name: string): Promise<void>;
  promptRouter(name: string, text: string): Promise<void>;
  promptAgent(name: string, agentId: string, text: string): void;
  resolvePermission(name: string, requestId: string, optionId: string): void;
  setMode(name: string, agentId: string, modeId: string): void;
  defineMesh(config: MeshConfig): Promise<void>;
  loadDefinitions(): Promise<void>;
  stopAll(): Promise<void>;
}

/** The MasterAgent surface the gateway depends on. */
export interface MasterLike {
  on(l: (u: any) => void): () => void;
  prompt(text: string): Promise<unknown>;
}

const CAP = 500; // ring-buffer cap for activity / mail / history
const TR_CAP = 1000; // per-conversation transcript cap

function cap<T>(arr: T[], n: number): T[] {
  return arr.length > n ? arr.slice(arr.length - n) : arr;
}

export class WebGateway {
  private state: GatewayState;
  private listeners = new Set<(m: ServerMsg) => void>();
  private agStatus = new Map<string, Map<AgentId, AgentStatus>>();
  private uidc = 0;
  private unsubMgr?: () => void;
  private unsubMaster?: () => void;

  constructor(
    private manager: ManagerLike,
    private master?: MasterLike,
  ) {
    this.state = {
      meshes: [],
      master: { status: master ? "starting" : "absent", transcript: [] },
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
      return {
        name: m.name,
        defined: m.defined,
        status: m.status,
        router,
        agents: config.agents.map((a) => ({
          id: a.id,
          harness: a.harness,
          role: a.role,
          status: (live ? tracked?.get(a.id) : undefined) ?? (live ? "spawning" : "dead"),
        })),
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
      pm = { config, transcripts: {}, activity: [], mail: [], pending: [], history: [] };
      this.state.perMesh[name] = pm;
    }
    return pm;
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

  // ── Event ingestion ──────────────────────────────────────────────────────────
  private ingest(name: string, e: MeshEvent): void {
    const pm = this.ensureMesh(name);
    switch (e.kind) {
      case "update":
        this.foldConv({ scope: "agent", mesh: name, agent: e.agent }, e.update, e.ts || now());
        break;
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
      case "mail": {
        const mailEntry: MailEntry = { id: this.uid(), ts: e.ts, from: e.from, to: e.to, body: e.body };
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
        this.broadcast({ t: "agent.status", name, agent: e.agent, status: e.status, detail: e.detail });
        break;
      }
    }
    this.refreshMeshes();
  }

  private ingestMaster(u: any): void {
    this.foldConv({ scope: "master" }, u, now());
  }

  // ── Commands (delegate to manager / master; echo user turns) ───────────────────
  async startMesh(name: string): Promise<void> {
    await this.manager.startMesh(name);
    this.refreshMeshes();
  }
  async stopMesh(name: string): Promise<void> {
    await this.manager.stopMesh(name);
    this.agStatus.delete(name);
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
  private routerId(name: string): string {
    try {
      return this.manager.routerOf(name);
    } catch {
      return this.manager.configOf(name).agents.find((a) => a.role === "router")?.id ?? "";
    }
  }
  async promptRouter(name: string, text: string): Promise<void> {
    this.foldConv({ scope: "agent", mesh: name, agent: this.routerId(name) }, { sessionUpdate: "user_message_chunk", content: { text } }, now());
    await this.manager.promptRouter(name, text);
  }
  promptAgent(name: string, agentId: string, text: string): void {
    this.foldConv({ scope: "agent", mesh: name, agent: agentId }, { sessionUpdate: "user_message_chunk", content: { text } }, now());
    this.manager.promptAgent(name, agentId, text);
  }
  configOf(name: string): MeshConfig {
    return this.manager.configOf(name);
  }
  resolvePermission(name: string, requestId: string, optionId: string): void {
    this.manager.resolvePermission(name, requestId, optionId);
  }
  setMode(name: string, agentId: string, modeId: string): void {
    this.manager.setMode(name, agentId, modeId);
  }
  async promptMaster(text: string): Promise<void> {
    if (!this.master) throw new Error("master agent is not configured");
    this.foldConv({ scope: "master" }, { sessionUpdate: "user_message_chunk", content: { text } }, now());
    await this.master.prompt(text);
  }

  // ── Master lifecycle status (set by main.ts around master.start/stop) ──────────
  setMasterStatus(status: MasterStatus): void {
    this.state.master.status = status;
    this.broadcast({ t: "master.status", status });
  }
}
