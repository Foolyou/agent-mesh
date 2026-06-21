// src/channels/controller.ts
//
// Runtime controller for the Feishu channel. It lets the backend boot with Feishu disabled,
// turns the channel on later when channels/feishu.json becomes complete+enabled, restarts it on
// config changes, and stops it when the file is disabled/invalid/removed.

import { watch, statSync, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import type { Channel, FeishuChannelConfig, FeishuChannelControl, FeishuChannelStatus, FeishuMeshBinding, FeishuMeshChatEnsureResult, FeishuProvisionJobPublic, FeishuProvisionStartRequest, MeshGateway } from "./types";
import type { AssistantGateway } from "./assistant-gateway";
import { feishuConfigPath, readFeishuConfig } from "./config";
import { feishuChannelKey } from "./gating";
import { FeishuProvisionRegistry } from "./provision";
import { createFeishuClient } from "./consumer";
import { defaultIdempotencyKey } from "./sender";
import { approvedFeishuOpenIds, readFeishuAuth } from "../auth-store";

export interface BuildFeishuChannelOpts {
  root: string;
  log?: (msg: string) => void;
  /** Gateway to the central Mesh Assistant for authorized p2p DMs (device-auth Phase 5). */
  assistant?: AssistantGateway;
}

export interface FeishuChannelControllerOptions extends BuildFeishuChannelOpts {
  watch?: boolean;
  buildChannel?: (mesh: MeshGateway, opts: BuildFeishuChannelOpts) => Channel | undefined;
  createChat?: (cfg: FeishuChannelConfig, meshName: string, userIds: string[]) => Promise<{ chatId: string; name?: string }>;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export class FeishuChannelController implements FeishuChannelControl {
  private readonly mesh: MeshGateway;
  private readonly root: string;
  private readonly log: (msg: string) => void;
  private readonly watchEnabled: boolean;
  private readonly buildChannel: (mesh: MeshGateway, opts: BuildFeishuChannelOpts) => Channel | undefined;
  private readonly assistant?: AssistantGateway;
  private readonly createChat: (cfg: FeishuChannelConfig, meshName: string, userIds: string[]) => Promise<{ chatId: string; name?: string }>;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly provision: FeishuProvisionRegistry;
  private chatQueue: Promise<unknown> = Promise.resolve();

  private watcher?: FSWatcher;
  private meshWatcher?: FSWatcher;
  private cancelReload?: () => void;
  private cancelMeshSync?: () => void;
  private active?: Channel;
  private activeSignature = "";
  private reloadInFlight?: Promise<FeishuChannelStatus>;
  private lastStatus: FeishuChannelStatus;
  private started = false;

  constructor(mesh: MeshGateway, opts: FeishuChannelControllerOptions) {
    this.mesh = mesh;
    this.root = opts.root;
    this.log = opts.log ?? ((m) => console.log(m));
    this.watchEnabled = opts.watch ?? true;
    this.buildChannel = opts.buildChannel ?? (() => undefined);
    this.assistant = opts.assistant;
    this.createChat = opts.createChat ?? sdkCreateMeshChat;
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
    this.lastStatus = disabledStatus(feishuConfigPath(this.root), "not loaded");
    this.provision = new FeishuProvisionRegistry({
      root: this.root,
      log: this.log,
      onConfigWritten: async () => {
        try {
          await this.syncMeshChats();
        } catch (e) {
          this.log(`feishu channel: mesh chat sync after provision failed: ${String(e)}`);
        }
        await this.reload();
      },
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const status = await this.reload();
    if (status.configured && status.enabled) {
      const results = await this.syncMeshChats();
      for (const result of results) {
        if (!result.ok) this.log(`feishu channel: failed to ensure mesh chat for "${result.mesh}": ${result.error ?? "unknown error"}`);
      }
    }
    if (this.watchEnabled) {
      await this.startWatcher();
      await this.startMeshWatcher();
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.cancelReload?.();
    this.cancelReload = undefined;
    this.cancelMeshSync?.();
    this.cancelMeshSync = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.meshWatcher?.close();
    this.meshWatcher = undefined;
    await this.stopActive();
    this.lastStatus = { ...this.lastStatus, state: "stopped", reason: "controller stopped", updatedAt: new Date().toISOString() };
  }

  status(): FeishuChannelStatus {
    return { ...this.lastStatus };
  }

  async reload(): Promise<FeishuChannelStatus> {
    if (this.reloadInFlight) return this.reloadInFlight;
    this.reloadInFlight = this.doReload().finally(() => {
      this.reloadInFlight = undefined;
    });
    return this.reloadInFlight;
  }

  async startProvision(input: FeishuProvisionStartRequest = {}): Promise<FeishuProvisionJobPublic> {
    return this.provision.start(input);
  }

  getProvision(id: string): FeishuProvisionJobPublic | undefined {
    return this.provision.get(id);
  }

  cancelProvision(id: string): FeishuProvisionJobPublic | undefined {
    return this.provision.cancel(id);
  }

  async ensureMeshChat(meshName: string): Promise<FeishuMeshChatEnsureResult> {
    const run = this.chatQueue.then(() => this.doEnsureMeshChat(meshName));
    this.chatQueue = run.catch(() => undefined);
    return run;
  }

  async syncMeshChats(): Promise<FeishuMeshChatEnsureResult[]> {
    const meshes = this.mesh.listMeshes().map((m) => m.name);
    const out: FeishuMeshChatEnsureResult[] = [];
    for (const meshName of meshes) {
      try {
        out.push(await this.ensureMeshChat(meshName));
      } catch (e) {
        out.push({ mesh: meshName, ok: false, error: String(e instanceof Error ? e.message : e) });
      }
    }
    return out;
  }

  private async doReload(): Promise<FeishuChannelStatus> {
    const loaded = readFeishuConfig(this.root);
    const path = loaded.path;
    if (!loaded.config) {
      await this.stopActive();
      this.activeSignature = "";
      this.lastStatus = {
        state: "disabled",
        configPath: path,
        configured: loaded.configured,
        enabled: loaded.enabled,
        reason: loaded.reason,
        updatedAt: new Date().toISOString(),
      };
      this.log(`feishu channel: ${loaded.reason ?? "disabled"}; channel disabled`);
      return this.status();
    }

    const signature = JSON.stringify(loaded.config);
    if (this.active && signature === this.activeSignature) {
      this.lastStatus = runningStatus(path, loaded.config);
      return this.status();
    }

    await this.stopActive();
    const next = this.buildChannel(this.mesh, { root: this.root, log: this.log, assistant: this.assistant });
    if (!next) {
      this.activeSignature = "";
      this.lastStatus = disabledStatus(path, "config did not build a channel");
      return this.status();
    }
    try {
      await next.start();
      this.active = next;
      this.activeSignature = signature;
      this.lastStatus = runningStatus(path, loaded.config);
      return this.status();
    } catch (e) {
      try {
        await next.stop();
      } catch {
        /* best effort */
      }
      this.active = undefined;
      this.activeSignature = "";
      this.lastStatus = {
        ...runningStatus(path, loaded.config),
        state: "error",
        reason: String(e),
      };
      this.log(`feishu channel: failed to start: ${String(e)}`);
      return this.status();
    }
  }

  private async stopActive(): Promise<void> {
    const ch = this.active;
    this.active = undefined;
    if (!ch) return;
    try {
      await ch.stop();
    } catch (e) {
      this.log(`feishu channel: stop failed: ${String(e)}`);
    }
  }

  private async startWatcher(): Promise<void> {
    const path = feishuConfigPath(this.root);
    await mkdir(dirname(path), { recursive: true });
    this.watcher = watch(dirname(path), (event, filename) => {
      if (filename && String(filename) !== "feishu.json") return;
      this.scheduleReload();
    });
  }

  private scheduleReload(): void {
    this.cancelReload?.();
    this.cancelReload = this.setTimer(() => {
      this.cancelReload = undefined;
      void this.reload();
    }, 150);
  }

  /** Watch the `<root>/meshes/` directory so a mesh config created/modified OUTSIDE the WebUI's
   *  `POST /api/meshes` (Assistant `create_mesh`, CLI, or a manual `meshes/<name>.json` write) still
   *  auto-creates its Feishu group without a restart. Reacts only to external `<mesh>.json` changes and
   *  debounces into the idempotent `syncMeshChats()`. No feedback loop: `syncMeshChats` writes
   *  `channels/feishu.json` (the other watcher's file), never `meshes/`. */
  private async startMeshWatcher(): Promise<void> {
    const dir = join(this.root, "meshes");
    await mkdir(dir, { recursive: true });
    this.meshWatcher = watch(dir, (_event, filename) => {
      const name = filename ? String(filename) : "";
      if (!isMeshConfigFile(name)) return; // ignore .sessions.json, temp/hidden names, the dir itself
      // Require a regular FILE: rejects delete events (path now gone) AND a directory named `<name>.json`.
      if (!statSync(join(dir, name), { throwIfNoEntry: false })?.isFile()) return;
      this.scheduleMeshSync();
    });
  }

  private scheduleMeshSync(): void {
    this.cancelMeshSync?.();
    this.cancelMeshSync = this.setTimer(() => {
      this.cancelMeshSync = undefined;
      void this.runMeshSync();
    }, 150);
  }

  /** Failure-isolated mesh sync for the watcher path. First make file-created meshes (CLI / hand-edited
   *  `meshes/<name>.json`) visible to the manager via `mergeDefinitionsFromDisk` (adds only missing
   *  meshes, never clobbers a live entry), so `listMeshes()` — and therefore `syncMeshChats()` — sees
   *  them. WebUI / Assistant `create_mesh` are already in memory. Per-mesh errors are contained by
   *  `syncMeshChats`; log non-ok results (mirroring `start()`) and swallow any top-level throw so the
   *  watcher never dies. */
  private async runMeshSync(): Promise<void> {
    try {
      await this.mesh.mergeDefinitionsFromDisk?.();
      const results = await this.syncMeshChats();
      for (const result of results) {
        if (!result.ok) this.log(`feishu channel: failed to ensure mesh chat for "${result.mesh}": ${result.error ?? "unknown error"}`);
      }
    } catch (e) {
      this.log(`feishu channel: mesh directory sync failed: ${String(e)}`);
    }
  }

  private async doEnsureMeshChat(meshName: string): Promise<FeishuMeshChatEnsureResult> {
    const mesh = String(meshName ?? "").trim();
    if (!mesh) throw new Error("mesh name is required");
    const loaded = readFeishuConfig(this.root);
    if (!loaded.config) throw new Error(loaded.reason ?? "feishu bot is not bound");
    const existing = loaded.config.bindings.find((b) => b.mesh === mesh);
    if (existing) return { mesh, chatId: existing.chatId, name: existing.name, created: false, ok: true };

    // Seed the new chat with the device-auth approved users (NOT the deprecated cfg.allowSenders, which
    // is empty after the device-auth migration). Bot-only when there are no approved users.
    const userIds = approvedFeishuOpenIds(await readFeishuAuth(this.root), feishuChannelKey(loaded.config.appId));
    const created = await this.createChat(loaded.config, mesh, userIds);
    const binding: FeishuMeshBinding = {
      mesh,
      chatId: created.chatId,
      name: created.name ?? feishuMeshChatName(mesh),
      source: "auto",
      createdAt: new Date().toISOString(),
    };
    await writeFeishuBinding(this.root, loaded.config, binding);
    await this.reload();
    return { mesh, chatId: binding.chatId, name: binding.name, created: true, ok: true };
  }
}

/** A watched `meshes/` filename that is a real mesh CONFIG (`<mesh>.json`) the controller should sync on.
 *  Excludes session state (`<mesh>.sessions.json`), atomic-write intermediates / editor temp / hidden
 *  names (anything with `.tmp`, a trailing `~`, or a leading dot), and non-JSON / the directory itself. */
export function isMeshConfigFile(name: string): boolean {
  if (!name || name.startsWith(".") || name.endsWith("~") || name.includes(".tmp")) return false;
  if (!name.endsWith(".json") || name.endsWith(".sessions.json")) return false;
  return true;
}

function runningStatus(path: string, cfg: FeishuChannelConfig): FeishuChannelStatus {
  const first = cfg.bindings[0];
  return {
    state: "running",
    configPath: path,
    configured: true,
    enabled: true,
    mesh: first?.mesh ?? cfg.mesh,
    chatId: first?.chatId ?? cfg.chatId,
    appId: cfg.appId,
    domain: cfg.domain,
    bindings: cfg.bindings.map((b) => ({ ...b })),
    updatedAt: new Date().toISOString(),
  };
}

function disabledStatus(path: string, reason: string): FeishuChannelStatus {
  return {
    state: "disabled",
    configPath: path,
    configured: false,
    enabled: false,
    reason,
    updatedAt: new Date().toISOString(),
  };
}

/** Feishu group name for a mesh: `<mesh>@<hostname>`. The mesh name and host each fall back to a
 *  sensible default when empty, and the total is length-capped (host budget reserved first) so a long
 *  hostname can't crowd out the mesh name or blow Feishu's group-name limit. `host` is injectable for
 *  tests; production uses os.hostname(). */
export function feishuMeshChatName(meshName: string, host: string = hostname()): string {
  const mesh = meshName.trim() || "mesh";
  const cleanedHost = (host ?? "").trim() || "host";
  const cappedHost = cleanedHost.slice(0, FEISHU_CHAT_HOST_MAX);
  const suffix = `@${cappedHost}`;
  const meshBudget = Math.max(1, FEISHU_CHAT_NAME_MAX - suffix.length);
  return `${mesh.slice(0, meshBudget)}${suffix}`;
}

/** Feishu caps a group name at 60 characters; reserve part of that budget for the host suffix. */
const FEISHU_CHAT_NAME_MAX = 60;
const FEISHU_CHAT_HOST_MAX = 30;

async function sdkCreateMeshChat(cfg: FeishuChannelConfig, meshName: string, userIds: string[]): Promise<{ chatId: string; name?: string }> {
  const client = createFeishuClient(cfg);
  const name = feishuMeshChatName(meshName);
  const res = await client.im.v1.chat.create({
    params: {
      user_id_type: "open_id",
      set_bot_manager: true,
      uuid: defaultIdempotencyKey(cfg.appId, meshName),
    },
    data: {
      name,
      description: `Agent Mesh group for ${meshName}`,
      ...(userIds.length ? { user_id_list: userIds } : {}), // device-auth approved openIds; bot-only when empty
      group_message_type: "chat",
    },
  });
  const code = res.code ?? 0;
  if (code !== 0) throw new Error(`Feishu create chat failed${res.msg ? `: ${res.msg}` : ` (code ${code})`}`);
  const chatId = res.data?.chat_id;
  if (!chatId) throw new Error("Feishu create chat returned no chat_id");
  return { chatId, name: res.data?.name || name };
}

async function writeFeishuBinding(root: string, cfg: FeishuChannelConfig, binding: FeishuMeshBinding): Promise<void> {
  const path = feishuConfigPath(root);
  await mkdir(dirname(path), { recursive: true });
  const raw = await readRawJson(path);
  const bindings = [...cfg.bindings.filter((b) => b.mesh !== binding.mesh && b.chatId !== binding.chatId), binding];
  const first = bindings[0];
  const next: Record<string, unknown> = {
    ...raw,
    enabled: true,
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain,
    botMentionId: cfg.botMentionId,
    botName: cfg.botName,
    requireMention: cfg.requireMention,
    allowSenders: cfg.allowSenders,
    outbound: cfg.outbound,
    websocket: cfg.websocket,
    bindings,
  };
  if (first) {
    next.mesh = first.mesh;
    next.chatId = first.chatId;
  } else {
    delete next.mesh;
    delete next.chatId;
  }
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function readRawJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
