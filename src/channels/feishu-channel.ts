// src/channels/feishu-channel.ts
//
// The FeishuChannel relay ties one Feishu bot to one or more hard-bound
// (Feishu conversation <-> mesh) pairs:
//   INBOUND  consumer message -> dedup -> sender whitelist -> @-gate -> strip @bot -> ensure the
//            matched mesh is running -> feed the router via MeshManager.promptRouter.
//   OUTBOUND subscribe MeshManager.on, keep ONLY each mesh's ROUTER `agent_message_chunk` text
//            (never other agents, never internal mail/steer), aggregate the chunks, and flush
//            the assembled text to the matched chat on the router's turn-idle boundary (with a
//            debounce fallback). Empty flushes are never sent.
//
// The consumer and sender are injected (makeConsumer / sender) so the relay logic is unit-tested
// against fakes; index.ts wires the real LarkConsumer + LarkSender. The channel only ever READS
// the mesh control plane (on / promptRouter / routerOf / listMeshes).

import type { MeshEvent, PromptImageRef } from "../acp/types";
import type { Channel, FeishuChannelConfig, FeishuMeshBinding, InboundImageDownloader, InboundMsg, MeshGateway } from "./types";
import { BoundedDedup } from "./dedup";
import { applyAllowSeed, feishuChannelKey, passesAtGate, senderAuthorized, stripBotMention } from "./gating";
import { storeUploads, type UploadFileLike } from "../web/uploads";
import { emptyFeishuAuth, feishuAuthPath, readFeishuAuth, updateFeishuAuth, type FeishuAuthFile } from "../auth-store";
import { ensureKeys, encryptAuthCode, type KeysFile } from "../auth-codes";
import { randomUUID, randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { dirname } from "node:path";

/** Reuse the web upload store for inbound image provisioning (落盘 + refs the agent can read). */
type StoreImages = (root: string, bucket: string, files: UploadFileLike[]) => Promise<PromptImageRef[]>;

/** Metadata for an in-turn segment boundary (e.g. the router invoking a tool). */
export interface SegmentBreak {
  /** Human-readable tool name/title to surface in the segment-break hint, if any. */
  toolName?: string;
}

/** What the channel needs from an outbound sender (LarkSender satisfies it). */
export interface OutboundSink {
  enqueue(text: string, key?: string): void;
  stop(): void;
  /** True streaming: push the latest full accumulated turn text; the sink edits one message in
   *  place. Optional — when absent the channel falls back to one-shot flushing. */
  streamUpdate?(fullText: string): void;
  /** Turn boundary (hard commit): flush the latest text, seal the live message, and clear the whole
   *  turn so the next turn is fresh. */
  streamCommit?(): void;
  /** In-turn boundary (soft commit): flush the current segment's latest text and seal the live
   *  message, but keep the SAME turn going so the next text opens a fresh message/card. Used at
   *  router tool-call boundaries. Optional — sinks without it simply never segment. */
  streamSegmentBreak?(meta?: SegmentBreak): void;
  /** Resolves when the sink has fully drained (no send/edit/commit in flight). The channel awaits
   *  this after a hard commit so the next turn doesn't race an async finalize. Absent => synchronous
   *  sink; the channel needs no commit barrier. */
  whenIdle?(): Promise<void>;
}

/** What the channel needs from an inbound source (LarkConsumer satisfies it). */
export interface InboundSource {
  start(): void;
  stop(): Promise<void> | void;
}

/** Narrow seam over the auth registry (`<root>/auth/feishu.json`) + code crypto. Defaults to the
 *  frozen auth-store / auth-codes against `root`; injected for tests. Present only when a `root`
 *  (or an explicit store) is configured — without it the channel runs the legacy in-memory gate. */
export interface FeishuAuthStore {
  /** Load the current registry snapshot (sanitized; never throws — empty on corrupt/missing). */
  read(): Promise<FeishuAuthFile>;
  /** Concurrency-safe read-modify-write of the registry. */
  update(mutator: (file: FeishuAuthFile) => void): Promise<FeishuAuthFile>;
  /** Ensure an active auth-code encryption key exists. */
  ensureKeys(): Promise<KeysFile>;
  /** Encrypt an authorization-code envelope for (channelKey, openId, appId). */
  encrypt(keys: KeysFile, input: { channelKey: string; openId: string; appId: string; ttlSeconds: number }): string;
  /** Watch the registry file for changes; `onChange` fires on each change. Returns an unsubscribe. */
  watch(onChange: () => void): () => void;
}

export interface FeishuChannelOptions {
  mesh: MeshGateway;
  config: FeishuChannelConfig;
  /** Legacy single-chat sender. Prefer `senders` when multiple bindings are configured. */
  sender?: OutboundSink;
  senders?: Map<string, OutboundSink>;
  makeConsumer: (onMessage: (m: InboundMsg) => void) => InboundSource;
  log?: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Flush the aggregated router text after this much chunk-silence (turn-idle fallback). */
  debounceMs?: number;
  dedupCapacity?: number;
  idempotencyKey?: (binding: FeishuMeshBinding, seq: number, text: string) => string;
  /** Data root for inbound image uploads (passed to storeUploads). Absent => image inbound disabled. */
  root?: string;
  /** Download an inbound image resource. Absent => image inbound disabled. */
  downloadImage?: InboundImageDownloader;
  /** Provision downloaded images into agent-readable refs. Defaults to the web {@link storeUploads}. */
  storeImages?: StoreImages;
  /** Dynamic auth registry seam. Defaults to the real auth-store/auth-codes against `root`. Injected
   *  for tests. Absent + no `root` => legacy in-memory allowSenders gate (silent deny, no auth code). */
  authStore?: FeishuAuthStore;
  /** Pending authorization-code (envelope) lifetime in seconds. Default 1 day. */
  authCodeTtlSeconds?: number;
  /** Short opaque auth-code id generator (collision-checked at write). Default: random base32. */
  shortAuthId?: () => string;
  /** Injectable clock (epoch ms) for pending timestamps in tests; defaults to Date.now. */
  now?: () => number;
}

interface BindingRuntime {
  binding: FeishuMeshBinding;
  sender: OutboundSink;
  routerId: string;
  buffer: string;
  currentMessageId?: string;
  currentMessageStart: number;
  flushSeq: number;
  replaying: boolean;
  cancelDebounce?: () => void;
  /** Streaming turn-boundary fallback timer (cancel fn): finalizes the turn if no router idle comes. */
  cancelStreamFinish?: () => void;
  /** A streaming turn has un-finalized content (chunks/tool calls since the last finish). Guards
   *  against double-commit when both the fallback timer and a late idle fire. */
  streamTurnActive: boolean;
  /** A hard commit is finalizing on an async sink; next-turn events are queued until it resolves. */
  committing: boolean;
  /** Monotonic barrier token. A clear/replay re-establishes the barrier with a new generation so a
   *  stale whenIdle() resolution (from a superseded barrier) is ignored and never drains the queue. */
  commitGen: number;
  /** Router events that arrived during a commit barrier, replayed in order once the sink is idle. */
  queuedEvents: MeshEvent[];
  startInFlight?: Promise<void>;
  /** Router tool-call ids already segmented on this turn; de-dups the tool_call + tool_call_update
   *  stream so a card is sealed once per distinct tool call regardless of interleaving. Cleared at
   *  turn boundaries / replay. */
  seenToolCalls: Set<string>;
}

export class FeishuChannel implements Channel {
  private readonly mesh: MeshGateway;
  private readonly cfg: FeishuChannelConfig;
  private readonly makeConsumer: (onMessage: (m: InboundMsg) => void) => InboundSource;
  private readonly log: (msg: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly debounceMs: number;
  private readonly streamCommitDebounceMs: number;
  private readonly streaming: boolean;
  private readonly dedup: BoundedDedup;
  private readonly idempotencyKey: (binding: FeishuMeshBinding, seq: number, text: string) => string;
  private readonly root?: string;
  private readonly downloadImage?: InboundImageDownloader;
  private readonly storeImages: StoreImages;
  private readonly runtimes: BindingRuntime[] = [];
  private readonly byChat = new Map<string, BindingRuntime>();
  private readonly byMesh = new Map<string, BindingRuntime>();

  // ── dynamic auth gate (Phase 3) ──
  /** Registry channel key for this bot: feishu:<appId>. The auth unit is (channelKey, openId). */
  private readonly channelKey: string;
  /** open_ids to seed as approved from config allowSenders (top-level + per-binding). */
  private readonly seedOpenIds: string[];
  /** Auth registry seam; present iff a root/store is configured (production always has root). */
  private readonly authStore?: FeishuAuthStore;
  private readonly authCodeTtlSeconds: number;
  private readonly shortAuthId: () => string;
  private readonly nowFn: () => number;
  /** Current in-memory registry snapshot — the gate's ONLY source (never read a file in onInbound).
   *  Seeded from config allowSenders at construction; replaced by the persisted store after load. */
  private authSnapshot?: FeishuAuthFile;
  private authUnwatch?: () => void;
  private cancelAuthReload?: () => void;

  private consumer?: InboundSource;
  private unsub?: () => void;
  private started = false;

  constructor(opts: FeishuChannelOptions) {
    this.mesh = opts.mesh;
    this.cfg = opts.config;
    this.makeConsumer = opts.makeConsumer;
    this.log = opts.log ?? (() => {});
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    this.debounceMs = opts.debounceMs ?? 800;
    this.streamCommitDebounceMs = opts.config.outbound?.streamCommitDebounceMs ?? 3000;
    this.streaming = opts.config.outbound?.streaming !== false;
    this.dedup = new BoundedDedup(opts.dedupCapacity ?? 1000);
    this.idempotencyKey = opts.idempotencyKey ?? (() => randomUUID());
    this.root = opts.root;
    this.downloadImage = opts.downloadImage;
    this.storeImages = opts.storeImages ?? storeUploads;
    // Dynamic auth gate setup. The store seam is the real auth-store/auth-codes against `root` (so
    // production needs no index.ts change), or an injected fake, or absent (legacy in-memory gate).
    this.channelKey = feishuChannelKey(opts.config.appId);
    this.seedOpenIds = collectAllowSenders(opts.config);
    this.authStore = opts.authStore ?? (opts.root ? realAuthStore(opts.root) : undefined);
    this.authCodeTtlSeconds = opts.authCodeTtlSeconds ?? 86400; // 1 day
    this.shortAuthId = opts.shortAuthId ?? defaultShortAuthId;
    this.nowFn = opts.now ?? (() => Date.now());
    // Gate snapshot. With a store (production root / injected): start UNDEFINED so the gate fails
    // closed until initAuth() loads the AUTHORITATIVE persisted registry — the allowSenders seed must
    // never act as a live gate (a CLI-revoked open_id still in allowSenders would otherwise slip
    // through the init window). Without a store (legacy/no-root): seed the in-memory snapshot so
    // allowSenders still gates synchronously.
    if (this.authStore) {
      this.authSnapshot = undefined;
    } else {
      const seed = emptyFeishuAuth();
      applyAllowSeed(seed, this.channelKey, this.seedOpenIds, new Date(this.nowFn()).toISOString());
      this.authSnapshot = seed;
    }
    const bindings = normalizedBindings(opts.config);
    for (const binding of bindings) {
      const sender = opts.senders?.get(binding.chatId) ?? (binding.chatId === opts.config.chatId ? opts.sender : undefined);
      if (!sender) {
        this.log(`feishu channel: no sender for mesh "${binding.mesh}" chat ${binding.chatId}; binding disabled`);
        continue;
      }
      if (this.byChat.has(binding.chatId) || this.byMesh.has(binding.mesh)) continue;
      const rt: BindingRuntime = { binding, sender, routerId: "", buffer: "", currentMessageStart: 0, flushSeq: 0, replaying: false, streamTurnActive: false, committing: false, commitGen: 0, queuedEvents: [], seenToolCalls: new Set() };
      this.runtimes.push(rt);
      this.byChat.set(binding.chatId, rt);
      this.byMesh.set(binding.mesh, rt);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const rt of this.runtimes) {
      try {
        rt.routerId = this.mesh.routerOf(rt.binding.mesh); // read-only resolution of the router agent
      } catch (e) {
        rt.routerId = "";
        this.log(`feishu channel: cannot resolve router for mesh "${rt.binding.mesh}": ${String(e)}; outbound mirroring disabled`);
      }
    }
    this.unsub = this.mesh.on((name, e) => this.onMeshEvent(name, e));
    // With a store, DEFER inbound until the authoritative snapshot is loaded: the init window must not
    // (a) let a revoked-but-seeded sender through (snapshot is undefined => deny), nor (b) auth-code a
    // seed user who is about to be authorized. Without a store, start inbound immediately on the seed.
    if (this.authStore) void this.initAuthThenConsume();
    else this.startConsumer();
    this.log(`feishu channel: started with ${this.runtimes.length} mesh chat binding(s)`);
  }

  /** Create + start the inbound consumer. Idempotent; no-op once stopped. */
  private startConsumer(): void {
    if (!this.started || this.consumer) return;
    this.consumer = this.makeConsumer((m) => {
      void this.onInbound(m);
    });
    this.consumer.start();
  }

  /** Persist-seed + load the authoritative auth snapshot, then start inbound — unless stopped meanwhile. */
  private async initAuthThenConsume(): Promise<void> {
    await this.initAuth();
    if (!this.started) return; // stopped during init: never start the consumer
    this.startConsumer();
  }

  /** With a store (root configured): persist the allowSenders seed (idempotent, never un-revoke), load
   *  the authoritative snapshot, and start the registry watcher. Without a store: keep the in-memory
   *  config seed (legacy). FAIL CLOSED — if persist/load fails, drop the snapshot so the gate denies. */
  private async initAuth(): Promise<void> {
    const store = this.authStore;
    if (!store) return; // legacy: in-memory config seed remains the snapshot
    try {
      await store.update((f) => {
        applyAllowSeed(f, this.channelKey, this.seedOpenIds, new Date(this.nowFn()).toISOString());
      });
      this.authSnapshot = await store.read();
      this.log(`feishu channel: auth registry loaded (approved=${countApproved(this.authSnapshot, this.channelKey)})`);
    } catch (e) {
      this.authSnapshot = undefined; // fail closed: deny everyone until a successful (re)load
      this.log(`feishu channel: auth registry init failed; failing closed error=${errorClass(e)}`);
    }
    if (!this.started) return; // stopped mid-init; don't attach a watcher
    try {
      this.authUnwatch = store.watch(() => this.scheduleAuthReload());
    } catch (e) {
      // A watcher we can't attach (e.g. the auth dir doesn't exist) must not crash startup; the
      // snapshot just won't live-reload until the next restart. Stay fail-closed if init also failed.
      this.log(`feishu channel: auth registry watch failed; continuing without live reload error=${errorClass(e)}`);
    }
  }

  private scheduleAuthReload(): void {
    this.cancelAuthReload?.();
    this.cancelAuthReload = this.setTimer(() => {
      this.cancelAuthReload = undefined;
      void this.reloadAuthSnapshot();
    }, 200);
  }

  private async reloadAuthSnapshot(): Promise<void> {
    const store = this.authStore;
    if (!store) return;
    try {
      this.authSnapshot = await store.read();
      this.log(`feishu channel: auth registry reloaded (approved=${countApproved(this.authSnapshot, this.channelKey)})`);
    } catch (e) {
      this.authSnapshot = undefined; // fail closed on reload failure
      this.log(`feishu channel: auth registry reload failed; failing closed error=${errorClass(e)}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.authUnwatch?.(); // close the registry watcher
    this.authUnwatch = undefined;
    this.cancelAuthReload?.(); // drop a pending debounced reload
    this.cancelAuthReload = undefined;
    for (const rt of this.runtimes) {
      rt.cancelDebounce?.();
      rt.cancelDebounce = undefined;
      rt.cancelStreamFinish?.(); // drop the streaming fallback timer so it can't fire after teardown
      rt.cancelStreamFinish = undefined;
      rt.buffer = ""; // drop any un-flushed tail rather than sending during teardown
      rt.currentMessageId = undefined;
      rt.currentMessageStart = 0;
      rt.streamTurnActive = false;
      rt.committing = false;
      rt.queuedEvents = []; // drop events queued behind a commit barrier; never send during teardown
      rt.seenToolCalls.clear();
      rt.replaying = false;
    }
    this.unsub?.();
    this.unsub = undefined;
    await this.consumer?.stop();
    for (const sender of new Set(this.runtimes.map((rt) => rt.sender))) sender.stop();
  }

  // ── inbound: Feishu -> router ───────────────────────────────────────────────
  private async onInbound(m: InboundMsg): Promise<void> {
    // Bound-chat gate FIRST: this channel serves only explicitly bound conversations. The bot may
    // sit in other chats, so events from unknown chats are silently dropped before dedup.
    // Silent on purpose; never log message content.
    const rt = this.byChat.get(m.chatId);
    if (!rt) return;
    const cfg = this.bindingConfig(rt.binding);
    this.log(`feishu channel: inbound ${inboundMeta(m)}`);
    if (this.dedup.check(m.eventId)) {
      this.log(`feishu channel: inbound dropped duplicate event=${m.eventId}`);
      return;
    }
    // @-gate FIRST so we only consider (and only ever auth-code) messages that actually address the
    // bot — a non-@ group message stays ignored, never triggering an authorization reply.
    if (!passesAtGate(m, cfg)) {
      this.log(`feishu channel: inbound dropped @gate event=${m.eventId} mentions=${mentionIds(m) || "-"}`);
      return;
    }
    // Dynamic sender gate: (feishu:<appId>, open_id) must be approved in the registry snapshot. Fail
    // closed; an unauthorized (but bot-addressed) sender gets a short auth code and is NOT routed.
    if (!senderAuthorized(this.authSnapshot, this.channelKey, m.senderId)) {
      await this.denyUnauthorized(rt, m);
      return;
    }

    // Image message: download the resource, provision agent-readable refs, prompt the router. Not a
    // text/command path — image content carries no prompt text.
    if (m.messageType === "image") {
      await this.handleInboundImage(rt, m);
      return;
    }

    const text = stripBotMention(m, cfg).trim();
    if (!text) {
      this.log(`feishu channel: inbound dropped empty event=${m.eventId}`);
      return;
    }

    const command = parseMeshCommand(text);
    if (command) {
      this.log(`feishu channel: inbound command ${command.kind} event=${m.eventId}`);
      await this.handleCommand(rt, command);
      return;
    }

    await this.deliverPrompt(rt, m.eventId, text);
  }

  /** Start the mesh if needed, finalize any residual streaming turn (pre-prompt boundary — never on
   *  command/gated messages), then feed the router the prompt (optionally with image refs). */
  private async deliverPrompt(rt: BindingRuntime, eventId: string, text: string, images?: PromptImageRef[]): Promise<void> {
    if (!(await this.ensureMeshRunning(rt))) return;
    // Pre-prompt boundary: finalize a not-yet-flushed reply so it can't concatenate with the next
    // turn's chunks. Complements the fallback timer (router replies can also be mail-triggered).
    if (rt.streamTurnActive || rt.buffer.trim()) {
      this.tlog(rt, "inbound-residual-finish");
      this.finalizeTurn(rt);
    }
    try {
      this.log(`feishu channel: routing inbound event=${eventId} to mesh "${rt.binding.mesh}"${images?.length ? ` images=${images.length}` : ""}`);
      await this.mesh.promptRouter(rt.binding.mesh, feishuUserPrompt(text), images);
    } catch (e) {
      this.log(`feishu channel: promptRouter failed: ${String(e)}`);
      rt.sender.enqueue(`消息已收到，但投递到 mesh "${rt.binding.mesh}" 失败：${shortError(e)}`);
    }
  }

  /** Download an inbound image, provision agent-readable refs (reusing the web upload store), and
   *  prompt the router. On any failure (no download capability, missing ids, download/store error)
   *  send a short notice to the group and do NOT prompt the router. Never logs/leaks the image_key. */
  private async handleInboundImage(rt: BindingRuntime, m: InboundMsg): Promise<void> {
    if (!this.downloadImage || !this.root) {
      this.log(`feishu channel: inbound image but image handling not configured event=${m.eventId}`);
      rt.sender.enqueue("收到一张图片，但当前未启用图片处理。");
      return;
    }
    if (!m.messageId || !m.imageKey) {
      this.log(`feishu channel: inbound image missing ids event=${m.eventId} hasMessageId=${!!m.messageId} hasImageKey=${!!m.imageKey}`);
      rt.sender.enqueue("收到一张图片但无法处理。");
      return;
    }
    let refs: PromptImageRef[];
    try {
      const img = await this.downloadImage({ messageId: m.messageId, imageKey: m.imageKey });
      const file: UploadFileLike = {
        name: img.name ?? "feishu-image",
        type: img.mimeType,
        size: img.bytes.byteLength,
        arrayBuffer: async () => new Uint8Array(img.bytes).buffer,
      };
      refs = await this.storeImages(this.root, rt.binding.mesh, [file]);
    } catch (e) {
      // Safe log only: a raw SDK error message can embed the request path / file_key, so log the
      // error CLASS (never the message) to avoid leaking the resource key.
      this.log(`feishu channel: inbound image download/store failed event=${m.eventId} error=${errorClass(e)}`);
      rt.sender.enqueue("收到一张图片但下载失败。");
      return;
    }
    if (!refs.length) {
      this.log(`feishu channel: inbound image produced no refs event=${m.eventId}`);
      rt.sender.enqueue("收到一张图片但无法处理。");
      return;
    }
    await this.deliverPrompt(rt, m.eventId, "用户发送了一张图片。", refs);
  }

  /** An unauthorized but bot-addressed sender. With a store: mint a short opaque auth code (the full
   *  encrypted envelope is written to pending[shortId], NEVER sent/logged) and reply with just the
   *  short id + how the operator approves it. Without a store (legacy/no root): silent low-noise deny. */
  private async denyUnauthorized(rt: BindingRuntime, m: InboundMsg): Promise<void> {
    if (!this.authStore) {
      this.log(`feishu channel: inbound denied (no auth registry) event=${m.eventId}`);
      return;
    }
    try {
      const shortId = await this.issueAuthCode(m.senderId);
      rt.sender.enqueue(authCodeReply(shortId));
      this.log(`feishu channel: inbound unauthorized -> issued auth code event=${m.eventId}`);
    } catch (e) {
      // never surface the raw crypto/store error (could embed key material / paths)
      this.log(`feishu channel: failed to issue auth code event=${m.eventId} error=${errorClass(e)}`);
      rt.sender.enqueue("授权失败，请稍后再试或联系管理员。");
    }
  }

  /** Mint a fresh encrypted auth-code envelope for this sender, store it under a collision-free short
   *  id (one pending per (channelKey, openId) — supersedes any prior), and return the short id. The
   *  envelope is the source of truth; only the short id is ever shown to the user. */
  private async issueAuthCode(openId: string): Promise<string> {
    const store = this.authStore!;
    const keys = await store.ensureKeys();
    const now = this.nowFn();
    let shortId = "";
    await store.update((f) => {
      // Reuse an existing pending id for this identity if one is present. The file is GC'd on read, so
      // any entry here is unexpired — reusing keeps a just-sent short id valid across repeated
      // messages (no new envelope minted), instead of replacing and invalidating it.
      for (const [id, p] of Object.entries(f.pending)) {
        if (p.channelKey === this.channelKey && p.openId === openId) {
          shortId = id;
          return;
        }
      }
      // None yet: mint a fresh envelope under a collision-free short id (all inside the lock).
      shortId = this.freshShortId(f.pending);
      f.pending[shortId] = {
        encryptedToken: store.encrypt(keys, { channelKey: this.channelKey, openId, appId: this.cfg.appId, ttlSeconds: this.authCodeTtlSeconds }),
        channelKey: this.channelKey,
        openId,
        appId: this.cfg.appId,
        firstSeenAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.authCodeTtlSeconds * 1000).toISOString(),
      };
    });
    return shortId;
  }

  /** A short opaque id not already present in `pending`. Retries to avoid a (vanishingly unlikely)
   *  collision; throws after a bounded number of attempts rather than overwrite another pending. */
  private freshShortId(pending: Record<string, unknown>): string {
    for (let i = 0; i < 100; i++) {
      const id = this.shortAuthId();
      if (id && !pending[id]) return id;
    }
    throw new Error("could not allocate a unique auth code id");
  }

  private async handleCommand(rt: BindingRuntime, command: MeshCommand): Promise<void> {
    const meshName = rt.binding.mesh;
    const status = () => this.mesh.listMeshes().find((x) => x.name === meshName)?.status ?? "unknown";
    try {
      switch (command.kind) {
        case "help":
          rt.sender.enqueue(meshCommandHelp(meshName));
          return;
        case "status":
          rt.sender.enqueue(`mesh "${meshName}" 当前状态：${status()}`);
          return;
        case "start":
          if (status() === "running") {
            rt.sender.enqueue(`mesh "${meshName}" 已在运行。`);
            return;
          }
          await this.startBoundMesh(rt);
          rt.sender.enqueue(`已启动 mesh "${meshName}"。`);
          return;
        case "stop":
          if (status() === "stopped") {
            rt.sender.enqueue(`mesh "${meshName}" 已经是 stopped。`);
            return;
          }
          await this.mesh.stopMesh(meshName);
          rt.sender.enqueue(`已停止 mesh "${meshName}"。`);
          return;
        case "restart":
          if (status() !== "stopped") await this.mesh.stopMesh(meshName);
          await this.startBoundMesh(rt);
          rt.sender.enqueue(`已重启 mesh "${meshName}"。`);
          return;
        case "new-session": {
          const before = status();
          await this.mesh.newAllSessions(meshName);
          rt.sender.enqueue(before === "running"
            ? `已为 mesh "${meshName}" 开启新 session。`
            : `已清空 mesh "${meshName}" 的 session；下次启动将使用新会话。`);
          return;
        }
      }
    } catch (e) {
      this.log(`feishu channel: command ${command.kind} failed: ${String(e)}`);
      rt.sender.enqueue(`命令执行失败：${shortError(e)}`);
    }
  }

  private async ensureMeshRunning(rt: BindingRuntime): Promise<boolean> {
    const meshName = rt.binding.mesh;
    const status = this.mesh.listMeshes().find((x) => x.name === meshName)?.status;
    if (status === "running") return true;
    if (status === "starting") {
      await rt.startInFlight;
      return this.mesh.listMeshes().find((x) => x.name === meshName)?.status === "running";
    }
    try {
      this.log(`feishu channel: mesh "${meshName}" not running; starting`);
      await this.startBoundMesh(rt);
      this.log(`feishu channel: mesh "${meshName}" started`);
      return true;
    } catch (e) {
      this.log(`feishu channel: failed to start mesh "${meshName}": ${String(e)}`);
      rt.sender.enqueue(`目标 mesh "${meshName}" 自动启动失败：${shortError(e)}`);
      return false;
    }
  }

  private async startBoundMesh(rt: BindingRuntime): Promise<void> {
    rt.startInFlight ??= this.mesh.startMesh(rt.binding.mesh).finally(() => {
      rt.startInFlight = undefined;
    });
    await rt.startInFlight;
  }

  // ── outbound: router -> Feishu ──────────────────────────────────────────────
  private onMeshEvent(name: string, e: MeshEvent): void {
    const rt = this.byMesh.get(name);
    if (!rt) return; // only bound meshes

    // Turn-start boundary (keyed by turn.agent, not a top-level agent field): a new ROUTER turn
    // beginning while we still hold un-finalized streaming content means the previous turn never
    // delivered (its idle was lost) — finalize it now, before this turn's chunks arrive, so the two
    // turns don't get concatenated onto one card. This is a reliable per-turn signal: agent_turn is
    // emitted for every turn start (not change-deduped like agent_activity).
    if (e.kind === "agent_turn" && e.phase === "started") {
      const turnAgent = (e.turn as { agent?: string } | undefined)?.agent;
      if (rt.routerId && turnAgent === rt.routerId && !rt.replaying && rt.streamTurnActive) {
        this.tlog(rt, "turnstart-residual-finish");
        this.finalizeTurn(rt);
      }
      return;
    }

    const agent = (e as { agent?: string }).agent;
    if (!rt.routerId || agent !== rt.routerId) return; // only the router agent (skips mail/steer/other agents)

    if (e.kind === "replay_started") {
      rt.replaying = true;
      this.clearOutboundBuffer(rt);
      return;
    }
    if (e.kind === "replay_finished") {
      rt.replaying = false;
      this.clearOutboundBuffer(rt);
      return;
    }
    if (rt.replaying) return; // never mirror historical session replay/backfill to Feishu

    this.dispatchRouterEvent(rt, e);
  }

  /** Handle a router chunk/tool-call/idle. While a previous hard commit is still finalizing on an
   *  async sink (commit barrier), queue these in order and replay them after `whenIdle()` resolves —
   *  otherwise the next turn's first chunk races the previous card's async finalize and gets dropped
   *  or applied to the old live card. */
  private dispatchRouterEvent(rt: BindingRuntime, e: MeshEvent): void {
    if (rt.committing) {
      rt.queuedEvents.push(e);
      this.tlog(rt, "queued-during-commit", ` kind=${e.kind}`);
      return;
    }
    if (e.kind === "update") {
      const u = e.update as
        | { sessionUpdate?: string; content?: unknown; messageId?: unknown; toolCallId?: unknown; title?: unknown; kind?: unknown }
        | undefined;
      if (u && u.sessionUpdate === "agent_message_chunk") {
        if (appendRouterChunk(rt, u)) {
          this.tlog(rt, "chunk-append");
          if (this.useStreaming(rt)) {
            this.streamCurrent(rt);
            this.scheduleStreamFinish(rt); // turn-boundary fallback if idle never arrives
          } else {
            this.scheduleFlush(rt);
          }
        }
        return;
      }
      if (u && (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")) {
        this.onRouterToolCall(rt, u);
        // A tool call (with no following text + lost idle) must still finalize: the fallback timer
        // lets CardSender materialize the hint-only card rather than carrying it into the next turn.
        if (this.useStreaming(rt)) this.scheduleStreamFinish(rt);
      }
      return;
    }
    // Router turn went idle => deliver the assembled message now (primary boundary).
    if (e.kind === "agent_activity" && e.activity === "idle") {
      this.tlog(rt, "idle-finish");
      this.finalizeTurn(rt);
    }
  }

  /** Streaming is on when configured AND the bound sink can edit messages in place. */
  private useStreaming(rt: BindingRuntime): boolean {
    return this.streaming && typeof rt.sender.streamUpdate === "function" && typeof rt.sender.streamCommit === "function";
  }

  /** Push the current full turn text so the sink edits the live message in place. */
  private streamCurrent(rt: BindingRuntime): void {
    if (rt.buffer.trim()) {
      rt.sender.streamUpdate!(rt.buffer);
      this.tlog(rt, "stream-update");
    }
  }

  /** Deliver the current turn through whichever path this binding uses. */
  private finalizeTurn(rt: BindingRuntime): void {
    if (this.useStreaming(rt)) this.streamFinish(rt);
    else this.flush(rt);
  }

  /** Streaming turn-boundary fallback: finalize the turn `streamCommitDebounceMs` after the last
   *  chunk/tool-call if no router idle arrives, so the next turn never appends onto this one. This is
   *  a silence timeout, not a true turn boundary: a real mid-turn pause longer than the window will
   *  finalize early and a later same-turn chunk opens a fresh card (no loss/concat) — accepted
   *  tradeoff for delivering replies that would otherwise be stuck waiting for a lost idle. */
  private scheduleStreamFinish(rt: BindingRuntime): void {
    rt.streamTurnActive = true;
    rt.cancelStreamFinish?.();
    rt.cancelStreamFinish = this.setTimer(() => {
      rt.cancelStreamFinish = undefined;
      this.tlog(rt, "stream-fallback-fired");
      this.streamFinish(rt);
    }, this.streamCommitDebounceMs);
    this.tlog(rt, "stream-fallback-scheduled", ` ms=${this.streamCommitDebounceMs}`);
  }

  /** Turn boundary: flush the final text, seal the live message, reset turn state. Idempotent — a
   *  second call (e.g. a late idle after the fallback timer already fired) is a no-op, so the turn
   *  is never committed twice. */
  private streamFinish(rt: BindingRuntime): void {
    if (rt.cancelStreamFinish) {
      rt.cancelStreamFinish();
      rt.cancelStreamFinish = undefined;
      this.tlog(rt, "stream-fallback-cancelled");
    }
    if (!rt.streamTurnActive) return; // nothing un-finalized; don't double-commit
    rt.streamTurnActive = false;
    if (rt.buffer.trim()) rt.sender.streamUpdate!(rt.buffer);
    rt.sender.streamCommit!();
    rt.buffer = "";
    rt.currentMessageId = undefined;
    rt.currentMessageStart = 0;
    rt.seenToolCalls.clear();
    this.tlog(rt, "stream-finish");
    this.beginCommitBarrier(rt);
  }

  /** streamCommit() on an async sink (CardSender/LarkSender) returns before the card finalize and
   *  state reset complete. Hold next-turn sender ops (queued in dispatchRouterEvent) until the sink
   *  reports idle, then drain them in order — so the next turn opens a fresh card instead of racing
   *  the previous commit. Sinks without whenIdle() are synchronous; no barrier needed. */
  private beginCommitBarrier(rt: BindingRuntime): void {
    const whenIdle = rt.sender.whenIdle?.bind(rt.sender);
    if (!whenIdle) return;
    rt.committing = true;
    const gen = ++rt.commitGen; // supersede any earlier barrier; its resolution becomes a no-op
    this.tlog(rt, "commit-barrier-begin", ` gen=${gen}`);
    whenIdle().then(
      () => this.endCommitBarrier(rt, gen),
      () => this.endCommitBarrier(rt, gen),
    );
  }

  private endCommitBarrier(rt: BindingRuntime, gen: number): void {
    if (gen !== rt.commitGen) return; // a newer barrier (e.g. from a replay clear) supersedes this one
    rt.committing = false;
    // Stopped or replaying mid-commit, or a re-clear happened: drop the queue, never send these.
    if (!this.started || rt.replaying) { rt.queuedEvents = []; return; }
    this.tlog(rt, "commit-barrier-end", ` gen=${gen} queued=${rt.queuedEvents.length}`);
    const queued = rt.queuedEvents;
    rt.queuedEvents = [];
    for (const e of queued) this.dispatchRouterEvent(rt, e);
  }

  /** A router tool call is an in-turn boundary: seal the current card so the tool call visually
   *  ends a segment and following text opens a fresh card. De-dup the tool_call + tool_call_update
   *  stream so we segment once per distinct tool call, not on every update. */
  private onRouterToolCall(rt: BindingRuntime, u: { sessionUpdate?: string; toolCallId?: unknown; title?: unknown; kind?: unknown }): void {
    if (!this.useStreaming(rt) || typeof rt.sender.streamSegmentBreak !== "function") return;
    const id = typeof u.toolCallId === "string" && u.toolCallId ? u.toolCallId : undefined;
    if (id) {
      if (rt.seenToolCalls.has(id)) return; // this tool call already segmented (any interleaving)
      rt.seenToolCalls.add(id);
    } else if (u.sessionUpdate !== "tool_call") {
      return; // no id and only an update -> treat as a continuation, don't re-segment
    }
    if (rt.buffer.trim()) rt.sender.streamUpdate!(rt.buffer); // ensure the segment shows its final text
    rt.sender.streamSegmentBreak!(toolSegmentMeta(u));
  }

  private clearOutboundBuffer(rt: BindingRuntime): void {
    rt.cancelDebounce?.();
    rt.cancelDebounce = undefined;
    rt.cancelStreamFinish?.();
    rt.cancelStreamFinish = undefined;
    rt.queuedEvents = []; // stale pre-clear events: replay drops the turn, never replay them
    const hadLive = this.useStreaming(rt) && rt.streamTurnActive;
    if (hadLive) rt.sender.streamCommit!(); // seal a live message before dropping (else nothing to seal)
    rt.buffer = "";
    rt.currentMessageId = undefined;
    rt.currentMessageStart = 0;
    rt.streamTurnActive = false;
    rt.seenToolCalls.clear();
    // Do NOT just clear `committing`: a prior streamFinish's commit (or the seal just issued) may
    // still be finalizing on the async sink. Re-establish the barrier so fresh post-replay events
    // wait for whenIdle() instead of racing the in-flight finalize; the new generation makes any
    // earlier barrier's resolution a no-op.
    if (rt.committing || hadLive) this.beginCommitBarrier(rt);
    else rt.committing = false;
  }

  private scheduleFlush(rt: BindingRuntime): void {
    rt.cancelDebounce?.();
    rt.cancelDebounce = this.setTimer(() => {
      rt.cancelDebounce = undefined;
      this.flush(rt);
    }, this.debounceMs);
  }

  private flush(rt: BindingRuntime): void {
    rt.cancelDebounce?.();
    rt.cancelDebounce = undefined;
    const text = rt.buffer.trim();
    rt.buffer = "";
    rt.currentMessageId = undefined;
    rt.currentMessageStart = 0;
    rt.seenToolCalls.clear();
    if (!text) return; // never send an empty flush
    rt.sender.enqueue(text, this.idempotencyKey(rt.binding, rt.flushSeq++, text));
  }

  /** Low-noise outbound-timing log. Never includes message text/content — only routing identifiers,
   *  the operation, buffer length, and a monotonic timestamp — for diagnosing turn-boundary timing. */
  private tlog(rt: BindingRuntime, op: string, extra = ""): void {
    this.log(`feishu outbound: ${op} mesh=${rt.binding.mesh} chat=${rt.binding.chatId} buflen=${rt.buffer.length}${extra} t=${Math.round(performance.now())}`);
  }

  private bindingConfig(binding: FeishuMeshBinding): FeishuChannelConfig {
    return {
      ...this.cfg,
      mesh: binding.mesh,
      chatId: binding.chatId,
      botMentionId: binding.botMentionId ?? this.cfg.botMentionId,
      botName: binding.botName ?? this.cfg.botName,
      requireMention: binding.requireMention ?? this.cfg.requireMention,
      allowSenders: binding.allowSenders ?? this.cfg.allowSenders,
    };
  }
}

function normalizedBindings(cfg: FeishuChannelConfig): FeishuMeshBinding[] {
  if (cfg.bindings?.length) return cfg.bindings;
  if (cfg.mesh && cfg.chatId) return [{ mesh: cfg.mesh, chatId: cfg.chatId }];
  return [];
}

/** Union of top-level and per-binding allowSenders — all map to the one channelKey (feishu:<appId>)
 *  since a bot has a single app credential (design §1.4). Used only to SEED the registry. */
function collectAllowSenders(cfg: FeishuChannelConfig): string[] {
  const out = new Set<string>();
  for (const s of cfg.allowSenders ?? []) if (s) out.add(s);
  for (const b of cfg.bindings ?? []) for (const s of b.allowSenders ?? []) if (s) out.add(s);
  return [...out];
}

/** Count approved entries for a channelKey in a snapshot — for a non-sensitive load log. */
function countApproved(file: FeishuAuthFile | undefined, channelKey: string): number {
  if (!file) return 0;
  return Object.values(file.allow).filter((e) => e.channelKey === channelKey && e.status === "approved").length;
}

/** The real auth registry seam: frozen auth-store/auth-codes against `root` + an fs.watch on the
 *  registry file's directory (created by the persist-seed before watch() is called). */
function realAuthStore(root: string): FeishuAuthStore {
  return {
    read: () => readFeishuAuth(root),
    update: (mutator) => updateFeishuAuth(root, mutator),
    ensureKeys: () => ensureKeys(root),
    encrypt: (keys, input) => encryptAuthCode(keys, input),
    watch: (onChange) => {
      const path = feishuAuthPath(root);
      const w = watch(dirname(path), (_event, filename) => {
        if (filename && String(filename) !== "feishu.json") return;
        onChange();
      });
      return () => w.close();
    },
  };
}

/** A short opaque auth-code id: 40 random bits as 8 unambiguous base32 chars (no I/L/O/U). Opaque to
 *  the user; the real secret is the encrypted envelope it indexes. */
function defaultShortAuthId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(5);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The group reply for an unauthorized sender: the short id + how the operator approves it. Carries NO
 *  open_id / app_id / encrypted envelope. */
function authCodeReply(shortId: string): string {
  return [
    "你尚未获授权使用本群的 mesh。",
    "请把下面的授权码发给管理员，由其在宿主机控制台批准：",
    `  ${shortId}`,
    "（管理员执行：mesh feishu approve <授权码>）",
  ].join("\n");
}

/** Extract plain text from an ACP content block (string, {text}, arrays, or nested content). */
function textOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (typeof content === "object") {
    const o = content as { text?: unknown; content?: unknown };
    if (typeof o.text === "string") return o.text;
    if (o.content !== undefined) return textOf(o.content);
  }
  return "";
}

function appendRouterChunk(rt: BindingRuntime, update: { content?: unknown; messageId?: unknown }): boolean {
  const text = textOf(update.content);
  if (!text) return false;
  const mid = typeof update.messageId === "string" && update.messageId.length > 0 ? update.messageId : undefined;
  if (!mid) {
    if (rt.currentMessageId === undefined && rt.buffer.length > rt.currentMessageStart) {
      const current = rt.buffer.slice(rt.currentMessageStart);
      if (text === current) return false;
      if (text.length > current.length && text.startsWith(current)) {
        rt.buffer = rt.buffer.slice(0, rt.currentMessageStart) + text;
        return true;
      }
    } else {
      rt.currentMessageId = undefined;
      rt.currentMessageStart = rt.buffer.length;
    }
    rt.buffer += text;
    return true;
  }

  if (rt.currentMessageId !== mid) {
    rt.currentMessageId = mid;
    rt.currentMessageStart = rt.buffer.length;
    rt.buffer += text;
    return true;
  }

  const current = rt.buffer.slice(rt.currentMessageStart);
  // Claude ACP can stream deltas and then resend the full block with the same messageId.
  // Drop exact full-resend duplicates, or replace a partial tail with the full block.
  if (text === current) return false;
  if (text.length > current.length && text.startsWith(current)) {
    rt.buffer = rt.buffer.slice(0, rt.currentMessageStart) + text;
    return true;
  }
  rt.buffer += text;
  return true;
}

function toolSegmentMeta(u: { title?: unknown; kind?: unknown }): SegmentBreak {
  const name = typeof u.title === "string" && u.title.trim() ? u.title.trim()
    : typeof u.kind === "string" && u.kind.trim() ? u.kind.trim()
    : undefined;
  return name ? { toolName: name } : {};
}

function feishuUserPrompt(text: string): string {
  return [
    "来自飞书授权群聊的用户消息。请直接回复该用户，回复内容会原样发回该飞书群；除非用户明确要求不要回复。",
    "",
    `用户消息：${text}`,
  ].join("\n");
}

function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 200 ? `${msg.slice(0, 197)}...` : msg;
}

/** Error class only (never the message) — safe to log for image failures where the SDK error text
 *  may embed the request path / resource key. */
function errorClass(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

function inboundMeta(m: InboundMsg): string {
  // No `sender` (open_id): this is logged BEFORE the auth gate, and an unauthorized sender's open_id
  // must not leak into logs (it identifies a not-yet-authorized person). Routing identifiers only.
  return `event=${m.eventId} chatType=${m.chatType} type=${m.messageType} mentions=${mentionIds(m) || "-"} textChars=${m.text.length}`;
}

function mentionIds(m: InboundMsg): string {
  return m.mentions.map((x) => x.id || x.name || x.key).filter(Boolean).join(",");
}

type MeshCommandKind = "help" | "status" | "start" | "stop" | "restart" | "new-session";
interface MeshCommand {
  kind: MeshCommandKind;
}

function parseMeshCommand(text: string): MeshCommand | undefined {
  const m = text.trim().match(/^\/(?:mesh|m)(?:\s+(.+))?$/i);
  if (!m) return undefined;
  const raw = (m[1] ?? "help").trim().toLowerCase().replace(/[_\s]+/g, "-");
  const first = raw.split("-")[0] || "help";
  if (raw === "help" || raw === "h" || raw === "帮助" || raw === "?") return { kind: "help" };
  if (raw === "status" || raw === "state" || raw === "状态") return { kind: "status" };
  if (raw === "start" || raw === "up" || raw === "启动") return { kind: "start" };
  if (raw === "stop" || raw === "down" || raw === "停止" || raw === "关闭") return { kind: "stop" };
  if (raw === "restart" || raw === "reboot" || raw === "重启") return { kind: "restart" };
  if (raw === "new-session" || raw === "newsession" || raw === "session" || raw === "reset-session" || raw === "新会话") {
    return { kind: "new-session" };
  }
  if (first === "new" && raw.includes("session")) return { kind: "new-session" };
  return { kind: "help" };
}

function meshCommandHelp(mesh: string): string {
  return [
    `mesh "${mesh}" 可用命令：`,
    "/mesh status - 查看状态",
    "/mesh start - 启动绑定 mesh",
    "/mesh stop - 停止绑定 mesh",
    "/mesh restart - 重启绑定 mesh",
    "/mesh new-session - 为所有 agent 开新 session",
  ].join("\n");
}
