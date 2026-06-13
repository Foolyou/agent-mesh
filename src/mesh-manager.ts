// src/mesh-manager.ts
// The deterministic global control plane. Owns mesh definitions (via MeshStore)
// and supervises one MeshHostClient per running mesh. Independent of the assistant
// agent: callable from the TUI, tests, and e2e.
import { resolve, join } from "node:path";
import { rm } from "node:fs/promises";
import { MeshStore } from "./mesh-store";
import { MeshHostClient } from "./mesh-host-client";
import { listLiveRecords, readRecord, removeRecord, pidAlive, type MeshHostRecord } from "./mesh-registry";
import { Mesh } from "./mesh";
import { validateAddAgent, validateAddEdge } from "./mesh-validate";
import { now } from "./acp/types";
import type { AgentConfig, AgentStatus, MeshConfig, MeshEdge, MeshEvent, ThinkingEffort } from "./acp/types";
import type { HarnessId } from "./acp/types";
import { isEffortSupportedByHarness, isThinkingEffort } from "./harness-utils";
import type { PromptImageRef } from "./acp/types";
import type { RespawnMode, RespawnResult } from "./control-plane";
import { deleteUploadBucket } from "./web/uploads";
import { assertSafeArtifactName, deleteArtifactMesh } from "./web/artifacts";
import { clearAgentSession, clearAllAgentSessions, setMeshExpectedAlive } from "./session-storage";

export type MeshStatus = "stopped" | "starting" | "running" | "dead";
export type StartSessionStrategy = "resume" | "fresh";

export interface StartMeshOptions {
  sessionStrategy?: StartSessionStrategy;
}

export interface MeshManagerOptions {
  /** Data root (default ~/.agent-mesh). meshesDir/runDir derive from it unless given. */
  root?: string;
  meshesDir?: string;
  runDir?: string;
  hostScript?: string;
  debug?: boolean;
  /** Idle lease (ms) passed to spawned daemons; 0 = survive indefinitely (default). */
  leaseMs?: number;
}

interface Entry {
  config: MeshConfig;
  status: MeshStatus;
  client?: MeshHostClient;
}

function validateArtifactNames(config: MeshConfig): void {
  assertSafeArtifactName(config.name);
  for (const agent of config.agents) assertSafeArtifactName(agent.id);
}

export class MeshManager {
  private store: MeshStore;
  private root?: string;
  private runDir: string;
  private hostScript?: string;
  private debug: boolean;
  private leaseMs: number;
  private entries = new Map<string, Entry>();
  private agentStatuses = new Map<string, Map<string, AgentStatus>>();
  private resolvedHarnesses = new Map<string, Map<string, { mesh: string; agentId: string; harnessId: HarnessId; path?: string; version?: string; spawnedAt: string }>>();
  private listeners = new Set<(name: string, e: MeshEvent) => void>();

  constructor(opts: MeshManagerOptions = {}) {
    this.root = opts.root;
    const meshesDir = opts.meshesDir ?? (opts.root ? join(opts.root, "meshes") : undefined);
    this.store = new MeshStore(meshesDir);
    this.runDir = opts.runDir ?? (opts.root ? join(opts.root, "run") : resolve(process.cwd(), ".mesh", "run"));
    // MESH_HOST_SCRIPT lets e2e tests substitute a fake daemon for the real mesh-host
    // (so the full backend can be exercised without spawning real agents). Unset in prod.
    this.hostScript = opts.hostScript ?? process.env.MESH_HOST_SCRIPT;
    this.debug = opts.debug ?? false;
    this.leaseMs = opts.leaseMs ?? 0;
  }

  on(listener: (name: string, e: MeshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(name: string, e: MeshEvent): void {
    if (e.kind === "agent_status") {
      let statuses = this.agentStatuses.get(name);
      if (!statuses) {
        statuses = new Map();
        this.agentStatuses.set(name, statuses);
      }
      statuses.set(e.agent, e.status);
      if (e.status === "dead" || e.status === "stopped") this.resolvedHarnesses.get(name)?.delete(e.agent);
    }
    if (e.kind === "agent_resolved_harness") {
      let resolved = this.resolvedHarnesses.get(name);
      if (!resolved) {
        resolved = new Map();
        this.resolvedHarnesses.set(name, resolved);
      }
      resolved.set(e.agent, { mesh: name, agentId: e.agent, harnessId: e.harness, path: e.path, version: e.version, spawnedAt: e.spawnedAt });
    }
    for (const l of this.listeners) l(name, e);
  }

  /** Load persisted definitions into memory as stopped meshes. */
  async loadDefinitions(): Promise<void> {
    for (const config of await this.store.load()) {
      validateArtifactNames(config);
      this.entries.set(config.name, { config, status: "stopped" });
    }
  }

  async defineMesh(config: MeshConfig): Promise<void> {
    validateArtifactNames(config);
    const existing = this.entries.get(config.name);
    if (existing && existing.status === "running") {
      throw new Error(`mesh "${config.name}" is running; stop it before redefining`);
    }
    await this.store.define(config); // validates + persists
    this.entries.set(config.name, { config, status: "stopped" });
  }

  /** Update one agent's thinking effort. Known config-safe values are persisted for the
   *  next start; advertised runtime-only values are forwarded live and not stored. */
  async setAgentEffort(name: string, agentId: string, effort?: string): Promise<void> {
    const entry = this.require(name);
    const target = entry.config.agents.find((a) => a.id === agentId);
    if (!target) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    if (effort !== undefined && (!isThinkingEffort(effort) || !isEffortSupportedByHarness(target.harness, effort))) {
      if (!entry.client) throw new Error(`agent "${agentId}" effort "${effort}" is runtime-only and mesh "${name}" is not running`);
      entry.client.setEffort(agentId, effort);
      return;
    }
    const persistedEffort = effort as ThinkingEffort | undefined;
    const patched: MeshConfig = { ...entry.config, agents: entry.config.agents.map((a) => (a.id === agentId ? { ...a, effort: persistedEffort } : a)) };
    await this.store.define(patched); // validates + persists
    entry.config = patched;
    entry.client?.setEffort(agentId, persistedEffort);
  }


  /** Delete a mesh definition (and forget it). Refuses while running/starting. */
  async deleteMesh(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (e && (e.status === "running" || e.status === "starting")) {
      throw new Error(`mesh "${name}" is running; stop it before deleting`);
    }
    await this.store.delete(name);
    this.entries.delete(name);
    await deleteUploadBucket(this.root, name);
    await deleteArtifactMesh(this.root, name);
  }

  private require(name: string): Entry {
    const e = this.entries.get(name);
    if (!e) throw new Error(`no such mesh "${name}"`);
    return e;
  }

  /** Build a client wired with this manager's callbacks (shared by start + reattach). */
  private buildClient(name: string, entry: Entry): MeshHostClient {
    const client = new MeshHostClient({
      name,
      config: entry.config,
      socketPath: join(this.runDir, `${name}.sock`),
      hostScript: this.hostScript,
      root: this.root,
      leaseMs: this.leaseMs,
      debug: this.debug,
      onEvent: (e) => this.emit(name, e),
      onClose: () => this.onDaemonLost(name, entry, client),
      onExit: () => this.onDaemonLost(name, entry, client),
    });
    return client;
  }

  /** A daemon we were attached to died/was lost (its socket closed unexpectedly). */
  private onDaemonLost(name: string, entry: Entry, client: MeshHostClient): void {
    if (entry.client !== client) return; // stale callback from a replaced client
    if (entry.status === "running" || entry.status === "starting") {
      entry.status = "dead";
      this.emit(name, { kind: "log", text: `mesh "${name}" host exited`, ts: now() });
    }
    entry.client = undefined;
    // a crashed daemon leaves its registry record + unix-socket file behind; clear both
    // so the mesh is immediately restartable (a fresh daemon re-listens on the path).
    void removeRecord(this.runDir, name).catch(() => {});
    void rm(join(this.runDir, `${name}.sock`), { force: true }).catch(() => {});
  }

  async startMesh(name: string, opts: StartMeshOptions = {}): Promise<void> {
    const entry = this.require(name);
    if (entry.status === "running" || entry.status === "starting") {
      throw new Error(`mesh "${name}" is already running`);
    }
    entry.status = "starting";
    if (opts.sessionStrategy === "fresh") {
      await clearAllAgentSessions(this.runDir, name);
    }
    await setMeshExpectedAlive(this.runDir, name, true);
    const client = this.buildClient(name, entry);
    entry.client = client;
    try {
      // If a daemon for this mesh is already alive (e.g. it outlived a previous backend
      // and we haven't reattached yet), connect to it instead of spawning a duplicate.
      const existing = await readRecord(this.runDir, name);
      if (existing && pidAlive(existing.pid)) await client.attach(existing);
      else await client.start();
    } catch (err) {
      entry.status = "stopped";
      entry.client = undefined;
      throw err;
    }
    entry.status = "running";
  }

  /** Reconnect to every daemon that outlived a previous backend. Call once on startup
   *  (after loadDefinitions). Returns the names it reattached to. */
  async reattachRunning(): Promise<string[]> {
    const reattached: string[] = [];
    for (const rec of await listLiveRecords(this.runDir)) {
      const entry = this.entries.get(rec.name);
      if (!entry || entry.status === "running" || entry.status === "starting") continue;
      entry.status = "starting";
      const client = this.buildClient(rec.name, entry);
      entry.client = client;
      try {
        await client.attach(rec);
        entry.status = "running";
        reattached.push(rec.name);
      } catch {
        entry.status = "stopped";
        entry.client = undefined;
      }
    }
    return reattached;
  }

  async stopMesh(name: string): Promise<void> {
    const entry = this.require(name);
    await entry.client?.stop();
    entry.client = undefined;
    entry.status = "stopped";
    await removeRecord(this.runDir, name).catch(() => {});
  }

  /** Disconnect from all daemons WITHOUT stopping them (backend shutdown). The meshes +
   *  their agents keep running; a future backend reattaches via reattachRunning(). */
  disconnectAll(): void {
    for (const e of this.entries.values()) e.client?.disconnect();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((n) => this.stopMesh(n).catch(() => {})));
  }

  /** Running daemons on disk (independent of this manager's in-memory state) — for `mesh ps`. */
  listRunning(): Promise<MeshHostRecord[]> {
    return listLiveRecords(this.runDir);
  }

  /** Reap a daemon by name (SIGTERM lets it stop agents + drop its record cleanly). */
  async kill(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry?.client) {
      await entry.client.stop();
      entry.client = undefined;
      entry.status = "stopped";
      return true;
    }
    const rec = await readRecord(this.runDir, name);
    if (rec && pidAlive(rec.pid)) {
      try {
        process.kill(rec.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await removeRecord(this.runDir, name).catch(() => {});
      return true;
    }
    return false;
  }

  promptRouter(name: string, text: string, images?: PromptImageRef[]): Promise<void> {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    const routerId = new Mesh(entry.config).router.id;
    entry.client.prompt(routerId, text, images);
    return Promise.resolve();
  }

  promptAgent(name: string, agentId: string, text: string, images?: PromptImageRef[]): void {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    entry.client.prompt(agentId, text, images);
  }

  removeQueuedTurn(name: string, agentId: string, turnId: string): void {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    entry.client.removeQueuedTurn(agentId, turnId);
  }

  steerAgent(name: string, agentId: string, text: string, images?: PromptImageRef[]): void {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    entry.client.steer(agentId, text, images);
  }

  resolvePermission(name: string, requestId: string, optionId: string): void {
    this.require(name).client?.resolve(requestId, optionId);
  }

  async setMode(name: string, agentId: string, modeId: string): Promise<void> {
    const entry = this.require(name);
    if (!entry.config.agents.some((a) => a.id === agentId)) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    const patched: MeshConfig = { ...entry.config, agents: entry.config.agents.map((a) => (a.id === agentId ? { ...a, mode: modeId } : a)) };
    await this.store.define(patched); // persists the runtime cache; does NOT restart the daemon
    entry.config = patched;
    entry.client?.setMode(agentId, modeId);
  }

  async setModel(name: string, agentId: string, modelId: string): Promise<void> {
    const entry = this.require(name);
    if (!entry.config.agents.some((a) => a.id === agentId)) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    const patched: MeshConfig = { ...entry.config, agents: entry.config.agents.map((a) => (a.id === agentId ? { ...a, model: modelId } : a)) };
    await this.store.define(patched); // persists the runtime cache; does NOT restart the daemon
    entry.config = patched;
    entry.client?.setModel(agentId, modelId);
  }

  async addEdge(name: string, edgeInput: MeshEdge): Promise<void> {
    const entry = this.require(name);
    const previous = entry.config;
    const statuses = this.agentStatuses.get(name);
    const edge = validateAddEdge(previous, edgeInput, (id) => statuses?.get(id));
    const patched: MeshConfig = { ...previous, edges: [...previous.edges, edge] };
    entry.config = patched;
    try {
      await this.store.define(patched);
    } catch (err) {
      entry.config = previous;
      throw err;
    }
    if (entry.status === "running" && entry.client) {
      try {
        entry.client.addEdge(edge);
      } catch (err) {
        this.emit(name, { kind: "log", text: `addEdge RPC failed for ${edge.from} -> ${edge.to}: ${String(err)}`, ts: now() });
      }
    }
  }

  async addAgent(name: string, cfg: AgentConfig, edgeInputs: MeshEdge[] = []): Promise<void> {
    const entry = this.require(name);
    const previous = entry.config;
    const statuses = this.agentStatuses.get(name);
    const agent = validateAddAgent(previous, cfg);
    let patched: MeshConfig = { ...previous, agents: [...previous.agents, agent], edges: [...previous.edges] };
    const edges: MeshEdge[] = [];
    for (const edgeInput of edgeInputs) {
      const edge = validateAddEdge(patched, edgeInput, (id) => statuses?.get(id));
      edges.push(edge);
      patched = { ...patched, edges: [...patched.edges, edge] };
    }

    entry.config = patched;
    try {
      await this.store.define(patched);
    } catch (err) {
      entry.config = previous;
      throw err;
    }
    if (entry.status === "running" && entry.client) {
      try {
        entry.client.addAgent(agent, edges);
      } catch (err) {
        this.emit(name, { kind: "log", text: `addAgent RPC failed for ${agent.id}: ${String(err)}`, ts: now() });
      }
    }
  }

  /** Operator-initiated interrupt of an agent's current turn. */
  interruptAgent(name: string, agentId: string): void {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    entry.client.interrupt(agentId);
  }

  /** Switch one agent to a fresh session. Running mesh → tell the daemon; otherwise
   *  invalidate the persisted id on disk so the next start spawns fresh. */
  async newAgentSession(name: string, agentId: string): Promise<void> {
    const entry = this.require(name);
    if (!entry.config.agents.some((a) => a.id === agentId)) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    if (entry.status === "running" && entry.client) entry.client.newSession(agentId);
    else await clearAgentSession(this.runDir, name, agentId);
  }

  async respawnAgent(name: string, agentId: string, mode: RespawnMode): Promise<RespawnResult> {
    const entry = this.require(name);
    if (!entry.config.agents.some((a) => a.id === agentId)) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    return entry.client.respawn(agentId, mode);
  }

  /** One-click: switch every agent in the mesh to a fresh session. */
  async newAllSessions(name: string): Promise<void> {
    const entry = this.require(name);
    if (entry.status === "running" && entry.client) entry.client.newAllSessions();
    else await clearAllAgentSessions(this.runDir, name);
  }

  wakeAgent(name: string, agentId: string): void {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    if (!entry.config.agents.some((a) => a.id === agentId)) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    entry.client.wakeAgent(agentId);
  }

  stopAgent(name: string, agentId: string): void {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    if (!entry.config.agents.some((a) => a.id === agentId)) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    entry.client.stopAgent(agentId);
  }

  pidOf(name: string): number | undefined {
    return this.entries.get(name)?.client?.pid;
  }

  routerOf(name: string): string {
    return new Mesh(this.require(name).config).router.id;
  }

  listMeshes(): { name: string; defined: boolean; status: MeshStatus }[] {
    return [...this.entries.values()].map((e) => ({ name: e.config.name, defined: true, status: e.status }));
  }

  listResolvedHarnesses(): { mesh: string; agentId: string; harnessId: HarnessId; path?: string; version?: string; spawnedAt: string }[] {
    return [...this.resolvedHarnesses.values()].flatMap((byAgent) => [...byAgent.values()].map((info) => ({ ...info })));
  }

  configOf(name: string): MeshConfig {
    return this.require(name).config;
  }
}
