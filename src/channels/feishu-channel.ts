// src/channels/feishu-channel.ts
//
// The FeishuChannel relay ties the pieces together for ONE hard-bound (Feishu conversation <->
// mesh) pair:
//   INBOUND  consumer message -> dedup -> sender whitelist -> @-gate -> strip @bot -> feed the
//            router via MeshManager.promptRouter. If the mesh is NOT running we DO NOT start it;
//            we reply a hint to Feishu instead.
//   OUTBOUND subscribe MeshManager.on, keep ONLY this mesh's ROUTER `agent_message_chunk` text
//            (never other agents, never internal mail/steer), aggregate the chunks, and flush
//            the assembled text to the bound chat on the router's turn-idle boundary (with a
//            debounce fallback). Empty flushes are never sent.
//
// The consumer and sender are injected (makeConsumer / sender) so the relay logic is unit-tested
// against fakes; index.ts wires the real LarkConsumer + LarkSender. The channel only ever READS
// the mesh control plane (on / promptRouter / routerOf / listMeshes).

import type { MeshEvent } from "../acp/types";
import type { Channel, FeishuChannelConfig, InboundMsg, MeshGateway } from "./types";
import { BoundedDedup } from "./dedup";
import { passesAtGate, senderAllowed, stripBotMention } from "./gating";

/** What the channel needs from an outbound sender (LarkSender satisfies it). */
export interface OutboundSink {
  enqueue(text: string, key?: string): void;
  stop(): void;
}

/** What the channel needs from an inbound source (LarkConsumer satisfies it). */
export interface InboundSource {
  start(): void;
  stop(): Promise<void> | void;
}

export interface FeishuChannelOptions {
  mesh: MeshGateway;
  config: FeishuChannelConfig;
  sender: OutboundSink;
  makeConsumer: (onMessage: (m: InboundMsg) => void) => InboundSource;
  log?: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Flush the aggregated router text after this much chunk-silence (turn-idle fallback). */
  debounceMs?: number;
  dedupCapacity?: number;
}

export class FeishuChannel implements Channel {
  private readonly mesh: MeshGateway;
  private readonly cfg: FeishuChannelConfig;
  private readonly sender: OutboundSink;
  private readonly makeConsumer: (onMessage: (m: InboundMsg) => void) => InboundSource;
  private readonly log: (msg: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly debounceMs: number;
  private readonly dedup: BoundedDedup;

  private consumer?: InboundSource;
  private unsub?: () => void;
  private routerId = "";
  private buffer = "";
  private flushSeq = 0;
  private cancelDebounce?: () => void;
  private started = false;

  constructor(opts: FeishuChannelOptions) {
    this.mesh = opts.mesh;
    this.cfg = opts.config;
    this.sender = opts.sender;
    this.makeConsumer = opts.makeConsumer;
    this.log = opts.log ?? (() => {});
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    this.debounceMs = opts.debounceMs ?? 800;
    this.dedup = new BoundedDedup(opts.dedupCapacity ?? 1000);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.routerId = this.mesh.routerOf(this.cfg.mesh); // read-only resolution of the router agent
    } catch (e) {
      this.routerId = "";
      this.log(`feishu channel: cannot resolve router for mesh "${this.cfg.mesh}": ${String(e)}; outbound mirroring disabled`);
    }
    this.unsub = this.mesh.on((name, e) => this.onMeshEvent(name, e));
    this.consumer = this.makeConsumer((m) => this.onInbound(m));
    this.consumer.start();
    this.log(`feishu channel: started for mesh "${this.cfg.mesh}" <-> chat ${this.cfg.chatId}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.cancelDebounce?.();
    this.cancelDebounce = undefined;
    this.buffer = ""; // drop any un-flushed tail rather than sending during teardown
    this.unsub?.();
    this.unsub = undefined;
    await this.consumer?.stop();
    this.sender.stop();
  }

  // ── inbound: Feishu -> router ───────────────────────────────────────────────
  private onInbound(m: InboundMsg): void {
    if (this.dedup.check(m.eventId)) return; // bounded dedup: drop redeliveries
    if (!senderAllowed(this.cfg, m.senderId)) return; // whitelist gate
    if (!passesAtGate(m, this.cfg.botName)) return; // @-gate (group: scope contract + mention)
    const text = stripBotMention(m, this.cfg.botName).trim();
    if (!text) return;

    // Do NOT auto-start a stopped mesh — reply a hint instead.
    const status = this.mesh.listMeshes().find((x) => x.name === this.cfg.mesh)?.status;
    if (status !== "running") {
      this.log(`feishu channel: mesh "${this.cfg.mesh}" not running; replying hint to chat`);
      this.sender.enqueue(`目标 mesh "${this.cfg.mesh}" 未运行，请先在 Mesh 控制台启动后再试。`);
      return;
    }
    void this.mesh
      .promptRouter(this.cfg.mesh, `[飞书消息] ${text}`)
      .catch((e) => this.log(`feishu channel: promptRouter failed: ${String(e)}`));
  }

  // ── outbound: router -> Feishu ──────────────────────────────────────────────
  private onMeshEvent(name: string, e: MeshEvent): void {
    if (name !== this.cfg.mesh) return; // only the bound mesh
    const agent = (e as { agent?: string }).agent;
    if (!this.routerId || agent !== this.routerId) return; // only the router agent (skips mail/steer/other agents)

    if (e.kind === "update") {
      const u = e.update as { sessionUpdate?: string; content?: unknown } | undefined;
      if (u && u.sessionUpdate === "agent_message_chunk") {
        this.buffer += textOf(u.content);
        this.scheduleFlush();
      }
      return;
    }
    // Router turn went idle => flush the assembled message now.
    if (e.kind === "agent_activity" && e.activity === "idle") this.flush();
  }

  private scheduleFlush(): void {
    this.cancelDebounce?.();
    this.cancelDebounce = this.setTimer(() => {
      this.cancelDebounce = undefined;
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    this.cancelDebounce?.();
    this.cancelDebounce = undefined;
    const text = this.buffer.trim();
    this.buffer = "";
    if (!text) return; // never send an empty flush
    this.sender.enqueue(text, `${this.cfg.mesh}:${this.flushSeq++}`);
  }
}

/** Extract plain text from an ACP content block (string, {text}, or unknown -> ""). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return "";
}
