// src/mesh-manager.ts
// The deterministic global control plane. Owns mesh definitions (via MeshStore)
// and supervises one MeshHostClient per running mesh. Independent of the master
// agent: callable from the TUI, tests, and e2e.
import { resolve, join } from "node:path";
import { MeshStore } from "./mesh-store";
import { MeshHostClient } from "./mesh-host-client";
import { Mesh } from "./mesh";
import { now } from "./acp/types";
import type { MeshConfig, MeshEvent } from "./acp/types";

export type MeshStatus = "stopped" | "starting" | "running" | "dead";

export interface MeshManagerOptions {
  meshesDir?: string;
  runDir?: string;
  hostScript?: string;
  debug?: boolean;
}

interface Entry {
  config: MeshConfig;
  status: MeshStatus;
  client?: MeshHostClient;
}

export class MeshManager {
  private store: MeshStore;
  private runDir: string;
  private hostScript?: string;
  private debug: boolean;
  private entries = new Map<string, Entry>();
  private listeners = new Set<(name: string, e: MeshEvent) => void>();

  constructor(opts: MeshManagerOptions = {}) {
    this.store = new MeshStore(opts.meshesDir);
    this.runDir = opts.runDir ?? resolve(process.cwd(), ".mesh", "run");
    this.hostScript = opts.hostScript;
    this.debug = opts.debug ?? false;
  }

  on(listener: (name: string, e: MeshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(name: string, e: MeshEvent): void {
    for (const l of this.listeners) l(name, e);
  }

  /** Load persisted definitions into memory as stopped meshes. */
  async loadDefinitions(): Promise<void> {
    for (const config of await this.store.load()) {
      this.entries.set(config.name, { config, status: "stopped" });
    }
  }

  async defineMesh(config: MeshConfig): Promise<void> {
    const existing = this.entries.get(config.name);
    if (existing && existing.status === "running") {
      throw new Error(`mesh "${config.name}" is running; stop it before redefining`);
    }
    await this.store.define(config); // validates + persists
    this.entries.set(config.name, { config, status: "stopped" });
  }

  /** Delete a mesh definition (and forget it). Refuses while running/starting. */
  async deleteMesh(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (e && (e.status === "running" || e.status === "starting")) {
      throw new Error(`mesh "${name}" is running; stop it before deleting`);
    }
    await this.store.delete(name);
    this.entries.delete(name);
  }

  private require(name: string): Entry {
    const e = this.entries.get(name);
    if (!e) throw new Error(`no such mesh "${name}"`);
    return e;
  }

  async startMesh(name: string): Promise<void> {
    const entry = this.require(name);
    if (entry.status === "running" || entry.status === "starting") {
      throw new Error(`mesh "${name}" is already running`);
    }
    entry.status = "starting";
    const client = new MeshHostClient({
      name,
      config: entry.config,
      socketPath: join(this.runDir, `${name}.sock`),
      hostScript: this.hostScript,
      debug: this.debug,
      onEvent: (e) => this.emit(name, e),
      onExit: () => {
        if (entry.status === "running" || entry.status === "starting") {
          entry.status = "dead";
          this.emit(name, { kind: "log", text: `mesh "${name}" host exited`, ts: now() });
        }
        // Reap the dead client's listening server + socket file (no leaked listeners).
        void client.stop().catch(() => {});
        if (entry.client === client) entry.client = undefined;
      },
    });
    entry.client = client;
    try {
      await client.start();
    } catch (err) {
      entry.status = "stopped";
      entry.client = undefined;
      throw err;
    }
    entry.status = "running";
  }

  async stopMesh(name: string): Promise<void> {
    const entry = this.require(name);
    await entry.client?.stop();
    entry.client = undefined;
    entry.status = "stopped";
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((n) => this.stopMesh(n).catch(() => {})));
  }

  promptRouter(name: string, text: string): Promise<void> {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    const routerId = new Mesh(entry.config).router.id;
    entry.client.prompt(routerId, text);
    return Promise.resolve();
  }

  promptAgent(name: string, agentId: string, text: string): void {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    entry.client.prompt(agentId, text);
  }

  resolvePermission(name: string, requestId: string, optionId: string): void {
    this.require(name).client?.resolve(requestId, optionId);
  }

  setMode(name: string, agentId: string, modeId: string): void {
    this.require(name).client?.setMode(agentId, modeId);
  }

  /** Operator-initiated interrupt of an agent's current turn. */
  interruptAgent(name: string, agentId: string): void {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    entry.client.interrupt(agentId);
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

  configOf(name: string): MeshConfig {
    return this.require(name).config;
  }
}
