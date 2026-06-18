// src/channels/sender.ts
//
// Outbound side: relays aggregated router text to the single bound Feishu conversation via
// `lark-cli im +messages-send --chat-id <chatId> --markdown <text> --idempotency-key <key>`.
// Sends are SERIALIZED through a queue with a minimum inter-send interval (basic rate limiting),
// each carries an idempotency key so a retried send is de-duplicated by Lark, and empty/blank
// text is never sent. The CLI invocation is behind the injectable SendFn seam so the queue,
// rate-limit, idempotency, and empty-guard logic are unit-testable without the real CLI.

export interface SendResult {
  code: number;
  stderr?: string;
}

/** Run one `lark-cli im +messages-send ...` invocation. Injected for tests. */
export type SendFn = (args: string[]) => Promise<SendResult>;

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
   *  default idempotency key (the relay supplies a turn-scoped key so retries dedupe). */
  enqueue(text: string, key?: string): void {
    if (this.stopped) return;
    if (!text.trim()) return; // empty/blank guard — never send
    this.queue.push({ text, key: key ?? this.keyOf(this.chatId, text) });
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
      const args = ["im", "+messages-send", "--as", "bot", "--chat-id", this.chatId, "--markdown", item.text, "--idempotency-key", item.key];
      try {
        const r = await this.send(args);
        if (r.code !== 0) this.log(`feishu sender: send failed (code ${r.code})${r.stderr ? `: ${r.stderr}` : ""}`);
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

/** FNV-1a (32-bit) → hex; deterministic so an identical (chatId,text) yields the same key. */
export function defaultIdempotencyKey(chatId: string, text: string): string {
  let h = 0x811c9dc5;
  const s = `${chatId}|${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `mesh-${(h >>> 0).toString(16).padStart(8, "0")}`;
}
