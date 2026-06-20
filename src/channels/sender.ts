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
  /** message_id of the created message; required so streaming can edit it in place. */
  messageId?: string;
}

export interface UpdateRequest {
  messageId: string;
  text: string;
}

/** Run one SDK send (create) operation. Injected for tests. */
export type SendFn = (req: SendRequest) => Promise<SendResult>;

/** Run one SDK edit (update) operation on an existing message. Injected for tests. */
export type UpdateFn = (req: UpdateRequest) => Promise<SendResult>;

/** Feishu rejects editing a message past 20 times (error 230072). */
const FEISHU_EDIT_LIMIT_CODE = 230072;

export interface LarkSenderOptions {
  chatId: string;
  send: SendFn;
  /** Edit an existing message in place. Required for true streaming; absent => no streaming. */
  update?: UpdateFn;
  /** Minimum gap between consecutive sends (ms). 0 disables rate limiting. */
  minIntervalMs?: number;
  /** Minimum gap between in-place edits of the live streaming message (ms). Default 1000. */
  streamMinEditIntervalMs?: number;
  /** Roll over to a fresh message once the live one has been edited this many times. Default 18. */
  maxEditsPerMessage?: number;
  log?: (msg: string) => void;
  /** Injected delay, so rate limiting is testable without real time. */
  wait?: (ms: number) => Promise<void>;
  /** Injected clock, so edit throttling is testable without real time. */
  now?: () => number;
  /** Deterministic idempotency key for a message when the caller does not supply one. */
  idempotencyKey?: (chatId: string, text: string) => string;
}

/** State of the single message currently being grown in place for a streaming turn. */
interface LiveMessage {
  messageId: string;
  editCount: number;
  /** Text currently shown in this message (the turn segment it owns). */
  sentText: string;
}

export class LarkSender {
  private readonly chatId: string;
  private readonly send: SendFn;
  private readonly update?: UpdateFn;
  private readonly minIntervalMs: number;
  private readonly streamMinEditIntervalMs: number;
  private readonly maxEdits: number;
  private readonly log: (msg: string) => void;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly keyOf: (chatId: string, text: string) => string;

  private readonly queue: { text: string; key: string }[] = [];
  private sending = false;
  private stopped = false;
  private idleResolvers: (() => void)[] = [];

  // ── streaming (in-place edit) state ─────────────────────────────────────────
  /** Latest full accumulated turn text the channel wants shown; undefined => nothing pending. */
  private streamPending?: string;
  /** A turn boundary was requested: flush the latest text now, then seal for the next turn. */
  private streamCommitting = false;
  /** An in-turn segment boundary (tool call) was requested: seal the current message and continue
   *  the same turn in a fresh one. */
  private streamSegmentBreaking = false;
  /** The message being grown right now (undefined => the next op creates a fresh one). */
  private live?: LiveMessage;
  /** Chars already sealed into PRIOR (rolled-over) messages of THIS turn. */
  private streamBaseOffset = 0;
  /** Timestamp of the last create/edit, for throttling. */
  private lastEditAt = 0;
  /** A driver loop is running. */
  private streamBusy = false;
  /** Streaming failed irrecoverably this turn; deliver the remainder via a one-shot send. */
  private streamGaveUp = false;

  constructor(opts: LarkSenderOptions) {
    this.chatId = opts.chatId;
    this.send = opts.send;
    this.update = opts.update;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.streamMinEditIntervalMs = opts.streamMinEditIntervalMs ?? 1000;
    this.maxEdits = opts.maxEditsPerMessage ?? 18;
    this.log = opts.log ?? (() => {});
    this.wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
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

  /** True streaming: record the latest full accumulated turn text and drive in-place edits of a
   *  single live message. Repeated calls coalesce — only the most recent text matters. Falls back
   *  to one-shot delivery (on commit) when no `update` seam is configured. */
  streamUpdate(fullText: string): void {
    if (this.stopped) return;
    if (!this.update) {
      // No edit capability: just remember the text and let commit do a single send.
      this.streamPending = fullText;
      return;
    }
    this.streamPending = fullText;
    void this.driveStream();
  }

  /** Turn boundary: flush the latest text immediately, then seal the live message so the next
   *  turn starts a brand-new message. */
  streamCommit(): void {
    if (this.stopped) return;
    if (!this.update) {
      // Degraded mode: deliver the remaining segment as one ordinary message.
      const full = this.streamPending ?? "";
      const seg = full.slice(this.streamBaseOffset);
      this.streamPending = undefined;
      this.streamBaseOffset = 0;
      if (seg.trim()) this.enqueue(seg);
      return;
    }
    this.streamCommitting = true;
    void this.driveStream();
  }

  /** In-turn boundary (tool call): seal the current live message and continue the SAME turn in a
   *  fresh one, so the boundary visually splits the reply. Never emits an empty message. */
  streamSegmentBreak(): void {
    if (this.stopped) return;
    if (!this.update) {
      // Degraded mode: flush the current segment now; the next text becomes a separate message.
      const full = this.streamPending ?? "";
      const seg = full.slice(this.streamBaseOffset);
      if (seg.trim()) {
        this.enqueue(seg);
        this.streamBaseOffset = full.length;
      }
      return;
    }
    this.streamSegmentBreaking = true;
    void this.driveStream();
  }

  /** Tool-call de-noising (R3): the plain-text sink does not surface tool calls. No-op — tools are
   *  shown only in the CardKit card; this keeps the text fallback clean (no per-tool splitting). */
  streamToolAnnotation(_text: string | undefined): void {
    /* intentionally empty */
  }

  /** Group-by-segment: the plain-text sink shows no tool annotations, so a prose boundary needs no
   *  special seal — the next text simply continues the stream. No-op (the CardKit path handles grouping). */
  streamSealSegment(): void {
    /* intentionally empty */
  }

  /** Resolves when the queue has fully drained and nothing is in flight. */
  whenIdle(): Promise<void> {
    if (!this.sending && this.queue.length === 0 && !this.streamBusy) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  /** Stop draining; in-flight send (if any) finishes, queued items are dropped. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.resetStream();
  }

  private resetStream(): void {
    this.streamPending = undefined;
    this.streamCommitting = false;
    this.streamSegmentBreaking = false;
    this.live = undefined;
    this.streamBaseOffset = 0;
    this.streamGaveUp = false;
  }

  /** Single serial driver for streaming ops: coalesces pending text, throttles edits, rolls over
   *  to a fresh message at the edit cap, and seals on commit. Only one instance runs at a time. */
  private async driveStream(): Promise<void> {
    if (this.streamBusy || !this.update) return;
    this.streamBusy = true;
    try {
      while (!this.stopped) {
        const full = this.streamPending ?? "";
        const segment = full.slice(this.streamBaseOffset);
        const liveUpToDate = this.live ? this.live.sentText === segment : segment.trim() === "";

        if (liveUpToDate || this.streamGaveUp) {
          // On give-up, only the text NOT yet confirmed on the live message needs a fresh message;
          // re-sending the shown prefix (or the whole turn) would duplicate confirmed content.
          const unshown = this.streamGaveUp ? (this.live ? segment.slice(this.live.sentText.length) : segment) : "";
          // Soft seal first: an in-turn boundary continues the SAME turn in a fresh message.
          if (this.streamSegmentBreaking && !this.streamCommitting) {
            if (this.streamGaveUp) {
              if (unshown.trim()) this.enqueue(unshown); // degraded: deliver only the unshown tail
              this.streamGaveUp = false;
            }
            this.streamBaseOffset = full.length; // everything so far is shown/sent for this segment
            this.live = undefined;
            this.streamSegmentBreaking = false;
            continue; // keep the turn going; the next text opens a new message
          }
          if (this.streamCommitting) {
            if (this.streamGaveUp && unshown.trim()) this.enqueue(unshown); // only the unshown tail
            this.live = undefined;
            this.streamBaseOffset = 0;
            this.streamCommitting = false;
            this.streamSegmentBreaking = false;
            this.streamGaveUp = false;
            this.streamPending = undefined;
          }
          break; // nothing more to do until the next streamUpdate/streamCommit
        }

        // Throttle: coalesce mid-stream edits; on commit only honor the hard rate limit.
        const minGap = this.streamCommitting ? this.minIntervalMs : this.streamMinEditIntervalMs;
        const waitMs = this.lastEditAt + minGap - this.now();
        if (waitMs > 0) {
          await this.wait(waitMs);
          continue; // re-read pending after waiting so the latest text wins
        }

        await this.doStreamOp(full);
      }
    } finally {
      this.streamBusy = false;
      if (!this.sending && this.queue.length === 0) {
        const resolvers = this.idleResolvers;
        this.idleResolvers = [];
        for (const r of resolvers) r();
      }
    }
  }

  /** Perform exactly one streaming network op (create, edit, or roll over) toward `full`. */
  private async doStreamOp(full: string): Promise<void> {
    const segment = full.slice(this.streamBaseOffset);

    if (!this.live) {
      if (!segment.trim()) return;
      try {
        const r = await this.send({ chatId: this.chatId, text: segment, uuid: safeUuid(this.keyOf(this.chatId, segment)) });
        this.lastEditAt = this.now();
        if (r.ok && r.messageId) {
          this.live = { messageId: r.messageId, editCount: 0, sentText: segment };
        } else {
          this.log(`feishu sender: stream create failed${r.code !== undefined ? ` (code ${r.code})` : ""}${r.message ? `: ${r.message}` : ""}`);
          this.streamGaveUp = true;
        }
      } catch (e) {
        this.lastEditAt = this.now();
        this.log(`feishu sender: stream create error: ${String(e)}`);
        this.streamGaveUp = true;
      }
      return;
    }

    if (this.live.sentText === segment) return;

    // Hit our own edit budget => seal this message and let the next iteration open a fresh one.
    if (this.live.editCount >= this.maxEdits) {
      this.rollOver();
      return;
    }

    try {
      const r = await this.update!({ messageId: this.live.messageId, text: segment });
      this.lastEditAt = this.now();
      if (r.ok) {
        this.live.sentText = segment;
        this.live.editCount++;
      } else if (r.code === FEISHU_EDIT_LIMIT_CODE) {
        this.rollOver(); // Feishu's own 20-edit cap; continue in a new message
      } else {
        this.log(`feishu sender: stream edit failed${r.code !== undefined ? ` (code ${r.code})` : ""}${r.message ? `: ${r.message}` : ""}`);
        this.streamGaveUp = true; // keep the last good state; stop hammering
      }
    } catch (e) {
      this.lastEditAt = this.now();
      this.log(`feishu sender: stream edit error: ${String(e)}`);
      this.streamGaveUp = true;
    }
  }

  /** Seal the live message and continue the turn in a new one (only its remaining text). */
  private rollOver(): void {
    if (this.live) this.streamBaseOffset += this.live.sentText.length;
    this.live = undefined;
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
    return { ok: code === 0, code, message: res.msg, messageId: res.data?.message_id };
  };
}

/** SDK seam for editing a text message in place (PUT /im/v1/messages/:message_id). */
export function sdkUpdate(client: lark.Client): UpdateFn {
  return async (req: UpdateRequest): Promise<SendResult> => {
    const res = await client.im.v1.message.update({
      path: { message_id: req.messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: req.text }),
      },
    });
    const code = res.code ?? 0;
    return { ok: code === 0, code, message: res.msg, messageId: res.data?.message_id };
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
