// src/channels/sender.ts
//
// Outbound side: relays aggregated router text to the single bound Feishu conversation via the
// official Feishu/Lark Node SDK. Sends are serialized through a queue with a minimum inter-send
// interval, each carries a deterministic uuid so Feishu can deduplicate retries, and blank text is
// never sent. The SDK invocation is behind SendFn so queue behavior is unit-tested without network.

import * as lark from "@larksuiteoapi/node-sdk";

export interface SendRequest {
  chatId: string;
  text: string;
  uuid: string;
}

export interface SendResult {
  ok: boolean;
  code?: number;
  message?: string;
}

/** Run one SDK send operation. Injected for tests. */
export type SendFn = (req: SendRequest) => Promise<SendResult>;

export interface LarkSenderOptions {
  chatId: string;
  send: SendFn;
  /** Minimum gap between consecutive sends (ms). 0 disables rate limiting. */
  minIntervalMs?: number;
  log?: (msg: string) => void;
  /** Injected delay, so rate limiting is testable without real time. */
  wait?: (ms: number) => Promise<void>;
  /** Deterministic idempotency key for a message when the caller does not supply one. */
  idempotencyKey?: (chatId: string, text: string) => string;
}

export class LarkSender {
  private readonly chatId: string;
  private readonly send: SendFn;
  private readonly minIntervalMs: number;
  private readonly log: (msg: string) => void;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly keyOf: (chatId: string, text: string) => string;

  private readonly queue: { text: string; key: string }[] = [];
  private sending = false;
  private stopped = false;
  private idleResolvers: (() => void)[] = [];

  constructor(opts: LarkSenderOptions) {
    this.chatId = opts.chatId;
    this.send = opts.send;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.log = opts.log ?? (() => {});
    this.wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.keyOf = opts.idempotencyKey ?? defaultIdempotencyKey;
  }

  /** Enqueue an outbound message. Blank text is dropped (no empty sends). `key` overrides the
   *  default idempotency key after being sanitized into a Feishu-compatible uuid. */
  enqueue(text: string, key?: string): void {
    if (this.stopped) return;
    if (!text.trim()) return;
    this.queue.push({ text, key: safeUuid(key ?? this.keyOf(this.chatId, text)) });
    void this.pump();
  }

  /** Resolves when the queue has fully drained and nothing is in flight. */
  whenIdle(): Promise<void> {
    if (!this.sending && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  /** Stop draining; in-flight send (if any) finishes, queued items are dropped. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    let first = true;
    while (!this.stopped && this.queue.length) {
      if (!first && this.minIntervalMs > 0) await this.wait(this.minIntervalMs);
      first = false;
      const item = this.queue.shift()!;
      try {
        const r = await this.send({ chatId: this.chatId, text: item.text, uuid: item.key });
        if (!r.ok) this.log(`feishu sender: send failed${r.code !== undefined ? ` (code ${r.code})` : ""}${r.message ? `: ${r.message}` : ""}`);
      } catch (e) {
        this.log(`feishu sender: send error: ${String(e)}`);
      }
    }
    this.sending = false;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) r();
  }
}

export function sdkSend(client: lark.Client): SendFn {
  return async (req: SendRequest): Promise<SendResult> => {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: req.chatId,
        msg_type: "text",
        content: JSON.stringify({ text: req.text }),
        uuid: req.uuid,
      },
    });
    const code = res.code ?? 0;
    return { ok: code === 0, code, message: res.msg };
  };
}

/** FNV-1a (32-bit) -> hex; deterministic so an identical (chatId,text) yields the same key. */
export function defaultIdempotencyKey(chatId: string, text: string): string {
  let h = 0x811c9dc5;
  const s = `${chatId}|${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `mesh-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function safeUuid(key: string): string {
  const trimmed = key.trim();
  if (/^[A-Za-z0-9_-]{1,50}$/.test(trimmed)) return trimmed;
  return defaultIdempotencyKey("uuid", trimmed);
}
