// src/mesh-manager.ts
// The deterministic global control plane. Owns mesh definitions (via MeshStore)
// and supervises one MeshHostClient per running mesh. Independent of the assistant
// agent: callable from the TUI, tests, and e2e.
import { resolve, join, dirname } from "node:path";
import { rm } from "node:fs/promises";
import { MeshStore } from "./mesh-store";
import { MeshHostClient, type MutationAck } from "./mesh-host-client";
import type { MutationApplyResult } from "./web/types";
import { listLiveRecords, readRecord, removeRecord, removeRecordIfDead, pidAlive, type MeshHostRecord } from "./mesh-registry";
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
import { boardsDirFor, deleteBoard, readBoard } from "./board-store";
import type { BoardActor, BoardCommand, BoardCommandResult, BoardDocument } from "./board";
import { clearAgentSession, clearAllAgentSessions, setMeshExpectedAlive } from "./session-storage";
import { isWindowsNamedPipePath, meshSocketPath } from "./mesh-socket";

export type MeshStatus = "stopped" | "starting" | "running" | "dead";
export type StartSessionStrategy = "resume" | "fresh";

export type { MutationApplyResult };

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

  /** Load persisted definitions and add ONLY meshes not already in memory (as stopped). Existing
   *  entries — running, starting, dead, or stopped — are left fully untouched (config, status, and
   *  client preserved), so a live mesh is never clobbered. Lets a file-created mesh (CLI / hand-edited
   *  `meshes/<name>.json`) become visible to the manager without a disruptive full reload. */
  async mergeDefinitionsFromDisk(): Promise<void> {
    for (const config of await this.store.load()) {
      if (!config?.name || this.entries.has(config.name)) continue; // preserve live/known entries; skip nameless junk
      validateArtifactNames(config);
      this.entries.set(config.name, { config, status: "stopped" });
    }
  }

  /** Safe reload for the WebUI "reload definitions" action: re-read definitions from disk WITHOUT
   *  clobbering live meshes. Unlike {@link loadDefinitions} (which resets every entry to
   *  `{status:"stopped"}` and drops the client — only correct at boot when nothing is running):
   *   - running/starting: preserved EXACTLY (config, status, and client untouched) — the daemon and
   *     its agents keep running and stay attached; never orphaned.
   *   - stopped/dead: config refreshed from disk (status and any client slot preserved).
   *   - new on disk: added as stopped.
   *   - known in memory but absent from disk: left unchanged (no deletion semantics here).
   *  {@link mergeDefinitionsFromDisk} stays add-only for the Feishu watcher; this method additionally
   *  refreshes stopped/dead configs, which is what an explicit user reload should do. */
  async reloadDefinitions(): Promise<void> {
    for (const config of await this.store.load()) {
      if (!config?.name) continue; // skip nameless junk
      validateArtifactNames(config);
      const existing = this.entries.get(config.name);
      if (!existing) {
        this.entries.set(config.name, { config, status: "stopped" }); // new disk mesh
      } else if (existing.status !== "running" && existing.status !== "starting") {
        existing.config = config; // stopped/dead: refresh config; keep status + client slot
      }
      // running/starting: leave the live entry fully untouched.
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
  async setAgentEffort(name: string, agentId: string, effort?: string): Promise<MutationApplyResult> {
    const entry = this.require(name);
    const target = entry.config.agents.find((a) => a.id === agentId);
    if (!target) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    if (effort !== undefined && (!isThinkingEffort(effort) || !isEffortSupportedByHarness(target.harness, effort))) {
      // Runtime-only advertised value: forwarded live, never persisted (saved:false).
      const client = entry.client;
      if (!client) throw new Error(`agent "${agentId}" effort "${effort}" is runtime-only and mesh "${name}" is not running`);
      return this.applyLiveMutation(() => client.setEffort(agentId, effort), false);
    }
    const persistedEffort = effort as ThinkingEffort | undefined;
    const patched: MeshConfig = { ...entry.config, agents: entry.config.agents.map((a) => (a.id === agentId ? { ...a, effort: persistedEffort } : a)) };
    await this.store.define(patched); // validates + persists
    entry.config = patched;
    const client = entry.client;
    return this.applyLiveMutation(client ? () => client.setEffort(agentId, persistedEffort) : undefined, true);
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
    // Board lives at <root>/boards/<mesh>.json. Derive the dir from runDir exactly as the
    // ControlPlane does (boardsDir = boardsDirFor(dirname(sessionRunDir)), sessionRunDir =
    // runDir), so cleanup and creation never disagree on the location.
    await deleteBoard(boardsDirFor(dirname(this.runDir)), name);
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
      socketPath: meshSocketPath(this.runDir, name),
      hostScript: this.hostScript,
      root: this.root,
      runDir: this.runDir,
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
    void this.cleanupLostDaemonArtifact(name).catch(() => {});
  }

  private async cleanupLostDaemonArtifact(name: string): Promise<void> {
    const result = await removeRecordIfDead(this.runDir, name);
    if (!result.removed) {
      this.emit(name, { kind: "log", text: `mesh "${name}" connection closed; host pid ${result.record?.pid} is still alive, keeping registry`, ts: now() });
      return;
    }
    // A truly dead daemon can leave its unix-socket file behind; clear it so the mesh is restartable.
    const socketPath = result.record?.socketPath ?? meshSocketPath(this.runDir, name);
    if (!isWindowsNamedPipePath(socketPath)) await rm(socketPath, { force: true }).catch(() => {});
  }

  private async waitPidGone(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && pidAlive(pid)) await Bun.sleep(100);
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
      await this.waitPidGone(rec.pid, 4000);
      const result = await removeRecordIfDead(this.runDir, name);
      if (!result.removed) {
        this.emit(name, { kind: "log", text: `mesh "${name}" pid ${rec.pid} survived SIGTERM; keeping registry`, ts: now() });
      }
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

  /** Run a live config mutation against the running daemon and fold its ack into a
   *  MutationApplyResult. `send` is undefined when the mesh is not running, in which case only
   *  the persisted desired value stands (applied:false, no error). A host error/timeout/close
   *  is captured as a failed live apply WITHOUT discarding the already-persisted desired. */
  private async applyLiveMutation(
    send: (() => Promise<MutationAck>) | undefined,
    saved: boolean,
  ): Promise<MutationApplyResult> {
    if (!send) return { saved, applied: false };
    try {
      const ack = await send();
      // Only an ACP-confirmed apply (setSessionMode) counts as applied. Model/effort are raw
      // config writes the host can only accept, so they report applied:false + accepted_by_host.
      return { saved, applied: ack.status === "applied_by_acp", ackStatus: ack.status };
    } catch (err: any) {
      return { saved, applied: false, error: String(err?.message ?? err) };
    }
  }

  async setMode(name: string, agentId: string, modeId: string): Promise<MutationApplyResult> {
    const entry = this.require(name);
    if (!entry.config.agents.some((a) => a.id === agentId)) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    const patched: MeshConfig = { ...entry.config, agents: entry.config.agents.map((a) => (a.id === agentId ? { ...a, mode: modeId } : a)) };
    await this.store.define(patched); // persists the runtime cache; does NOT restart the daemon
    entry.config = patched;
    const client = entry.client;
    return this.applyLiveMutation(client ? () => client.setMode(agentId, modeId) : undefined, true);
  }

  async setModel(name: string, agentId: string, modelId: string): Promise<MutationApplyResult> {
    const entry = this.require(name);
    if (!entry.config.agents.some((a) => a.id === agentId)) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    const patched: MeshConfig = { ...entry.config, agents: entry.config.agents.map((a) => (a.id === agentId ? { ...a, model: modelId } : a)) };
    await this.store.define(patched); // persists the runtime cache; does NOT restart the daemon
    entry.config = patched;
    const client = entry.client;
    return this.applyLiveMutation(client ? () => client.setModel(agentId, modelId) : undefined, true);
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

  // ── collaboration board ────────────────────────────────────────────────────
  // The board dir mirrors the ControlPlane's derivation (boardsDir =
  // boardsDirFor(dirname(sessionRunDir)), sessionRunDir == runDir), so a running daemon and
  // this read path agree on <root>/boards/<mesh>.json.
  private boardsDir(): string {
    return boardsDirFor(dirname(this.runDir));
  }

  /** Read the durable board from disk. Works for stopped AND running meshes: the daemon
   *  awaits the disk mirror before emitting, so the file is current. */
  async readBoard(name: string): Promise<BoardDocument> {
    this.require(name); // 404 for unknown meshes
    return readBoard(this.boardsDir(), name);
  }

  /** Mutate the board. Running-only: routed through the daemon RPC (the daemon's in-memory
   *  board is the source of truth). There is no stopped-mesh write path. */
  async boardCommand(name: string, actor: BoardActor, command: BoardCommand, expectedBoardRevision: number): Promise<BoardCommandResult> {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    return entry.client.boardCommand(actor, command, expectedBoardRevision);
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
