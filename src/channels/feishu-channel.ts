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

import type { MeshEvent } from "../acp/types";
import type { Channel, FeishuChannelConfig, FeishuMeshBinding, InboundMsg, MeshGateway } from "./types";
import { BoundedDedup } from "./dedup";
import { passesAtGate, senderAllowed, stripBotMention } from "./gating";
import { randomUUID } from "node:crypto";

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
}

/** What the channel needs from an inbound source (LarkConsumer satisfies it). */
export interface InboundSource {
  start(): void;
  stop(): Promise<void> | void;
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
  private readonly runtimes: BindingRuntime[] = [];
  private readonly byChat = new Map<string, BindingRuntime>();
  private readonly byMesh = new Map<string, BindingRuntime>();

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
    const bindings = normalizedBindings(opts.config);
    for (const binding of bindings) {
      const sender = opts.senders?.get(binding.chatId) ?? (binding.chatId === opts.config.chatId ? opts.sender : undefined);
      if (!sender) {
        this.log(`feishu channel: no sender for mesh "${binding.mesh}" chat ${binding.chatId}; binding disabled`);
        continue;
      }
      if (this.byChat.has(binding.chatId) || this.byMesh.has(binding.mesh)) continue;
      const rt: BindingRuntime = { binding, sender, routerId: "", buffer: "", currentMessageStart: 0, flushSeq: 0, replaying: false, streamTurnActive: false, seenToolCalls: new Set() };
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
    this.consumer = this.makeConsumer((m) => {
      void this.onInbound(m);
    });
    this.consumer.start();
    this.log(`feishu channel: started with ${this.runtimes.length} mesh chat binding(s)`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const rt of this.runtimes) {
      rt.cancelDebounce?.();
      rt.cancelDebounce = undefined;
      rt.buffer = ""; // drop any un-flushed tail rather than sending during teardown
      rt.currentMessageId = undefined;
      rt.currentMessageStart = 0;
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
    if (!senderAllowed(cfg, m.senderId)) {
      this.log(`feishu channel: inbound dropped sender event=${m.eventId} sender=${m.senderId}`);
      return;
    }
    if (!passesAtGate(m, cfg)) {
      this.log(`feishu channel: inbound dropped @gate event=${m.eventId} mentions=${mentionIds(m) || "-"}`);
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

    if (!(await this.ensureMeshRunning(rt))) return;
    // Deterministic pre-prompt boundary: finalize any residual streaming buffer from the previous
    // turn BEFORE feeding a new prompt, so a not-yet-flushed reply can't get concatenated with the
    // next turn's chunks. Only here (we are about to call promptRouter) — never on command/gated
    // messages. Complements (does not replace) the fallback timer, since router replies can also be
    // triggered by mail rather than inbound Feishu messages.
    if (rt.streamTurnActive || rt.buffer.trim()) {
      this.tlog(rt, "inbound-residual-finish");
      this.finalizeTurn(rt);
    }
    try {
      this.log(`feishu channel: routing inbound event=${m.eventId} to mesh "${rt.binding.mesh}"`);
      await this.mesh.promptRouter(rt.binding.mesh, feishuUserPrompt(text));
    } catch (e) {
      this.log(`feishu channel: promptRouter failed: ${String(e)}`);
      rt.sender.enqueue(`消息已收到，但投递到 mesh "${rt.binding.mesh}" 失败：${shortError(e)}`);
    }
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
   *  chunk/tool-call if no router idle arrives, so the next turn never appends onto this one. */
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
    if (this.useStreaming(rt)) rt.sender.streamCommit!(); // seal any live message before dropping
    rt.buffer = "";
    rt.currentMessageId = undefined;
    rt.currentMessageStart = 0;
    rt.streamTurnActive = false;
    rt.seenToolCalls.clear();
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

function inboundMeta(m: InboundMsg): string {
  return `event=${m.eventId} chatType=${m.chatType} sender=${m.senderId} type=${m.messageType} mentions=${mentionIds(m) || "-"} textChars=${m.text.length}`;
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
