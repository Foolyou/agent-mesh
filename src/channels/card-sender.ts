// src/channels/card-sender.ts
//
// Outbound side, CardKit streaming variant (the default path). Instead of editing a plain text
// message in place — capped by Feishu at 20 edits per message — a router turn is mirrored into a
// single JSON 2.0 streaming card:
//   1. cardkit.v1.card.create        build a card entity carrying one streaming markdown element.
//   2. im.v1.message.create          send msg_type:"interactive" referencing the card_id (once).
//   3. cardkit.v1.cardElement.content push the full accumulated markdown, sequence strictly
//                                     increasing, coalescing bursts under the 10/s single-card cap.
//   4. cardkit.v1.card.settings      on the turn boundary, finalize (streaming_mode=false).
//
// The four CardKit operations are behind injected seams (create/send/content/finalize) so the
// state machine is unit-tested without network. A text `OutboundSink` (the existing LarkSender) is
// kept as a fallback: if ANY CardKit op fails, the turn degrades to text and continues from AFTER
// the content already confirmed on the card — never re-sending shown text, never dropping the tail.
//
// This class satisfies the channel's OutboundSink contract, so FeishuChannel drives it exactly like
// the text sender (enqueue / streamUpdate / streamCommit / stop).

import * as lark from "@larksuiteoapi/node-sdk";
import type { OutboundSink, SegmentBreak } from "./feishu-channel";
import { safeUuid, defaultIdempotencyKey } from "./sender";

/** Why a card is being finalized. Card finalization is unified through one path so tool-call
 *  boundaries, size rollover, the streaming-window rollover, and the turn boundary all behave
 *  identically w.r.t. sequence management and fallback accounting. */
export type FinalizeReason = "segment_break" | "size_rollover" | "stream_timeout_rollover" | "turn_commit";

export interface CardCreateRequest {
  /** The markdown element id the content/finalize ops will target. */
  elementId: string;
  /** Initial markdown content rendered when the card is first shown. */
  text: string;
}
export interface CardCreateResult {
  ok: boolean;
  code?: number;
  message?: string;
  cardId?: string;
}

export interface CardSendRequest {
  chatId: string;
  cardId: string;
  uuid: string;
}
export interface CardSendResult {
  ok: boolean;
  code?: number;
  message?: string;
  messageId?: string;
}

export interface CardContentRequest {
  cardId: string;
  elementId: string;
  content: string;
  /** Strictly increasing per card; Feishu rejects out-of-order ops with 300317. */
  sequence: number;
  /** Stable idempotency key (cardId + sequence) so a retried op is de-duplicated by Feishu. */
  uuid: string;
}
export interface CardContentResult {
  ok: boolean;
  code?: number;
  message?: string;
}

export interface CardFinalizeRequest {
  cardId: string;
  sequence: number;
  /** Stable idempotency key (cardId + sequence). */
  uuid: string;
  /** Summary to set on the card so it doesn't stay stuck showing "generating". */
  summary: string;
}
export interface CardFinalizeResult {
  ok: boolean;
  code?: number;
  message?: string;
}

export type CardCreateFn = (req: CardCreateRequest) => Promise<CardCreateResult>;
export type CardSendFn = (req: CardSendRequest) => Promise<CardSendResult>;
export type CardContentFn = (req: CardContentRequest) => Promise<CardContentResult>;
export type CardFinalizeFn = (req: CardFinalizeRequest) => Promise<CardFinalizeResult>;

/** Feishu rejects a card op whose sequence is not strictly greater than the last applied one. */
export const CARD_SEQUENCE_ERROR_CODE = 300317;

const DEFAULT_ELEMENT_ID = "md";

export interface CardSenderOptions {
  chatId: string;
  create: CardCreateFn;
  send: CardSendFn;
  content: CardContentFn;
  finalize: CardFinalizeFn;
  /** Text sender used when CardKit fails; the reply is never lost. */
  fallback: OutboundSink;
  /** Markdown element id inside the card. Default "md". */
  elementId?: string;
  /** Minimum gap between content edits of the live card (ms). Single card cap is 10/s. Default 250. */
  minEditIntervalMs?: number;
  /** Minimum gap honored at the turn boundary (finalize). Default 0. */
  minIntervalMs?: number;
  /** Show a small hint on a card when it is sealed by a tool-call segment break. Default true. */
  enableToolHint?: boolean;
  /** Render the tool-call hint shown as the FIRST line of the next segment's card. Centralized so
   *  prdmgr can tune copy. Return "" to suppress. Default {@link defaultToolHint}. */
  toolHint?: (meta?: SegmentBreak) => string;
  /** Derive the card summary (chat-list / notification text) from the card body. Centralized so it
   *  can be tuned later. Default {@link defaultCardSummary}. */
  cardSummary?: (body: string) => string;
  log?: (msg: string) => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  idempotencyKey?: (chatId: string, text: string) => string;
}

/** The card currently being grown in place for a streaming turn. */
interface LiveCard {
  cardId: string;
  messageId: string;
  /** Turn-text body currently confirmed on this card (WITHOUT the cosmetic hint prefix). Tracked as
   *  turn text only so offsets and fallback accounting never count the hint. */
  sentText: string;
}

export class CardSender implements OutboundSink {
  private readonly chatId: string;
  private readonly create: CardCreateFn;
  private readonly send: CardSendFn;
  private readonly content: CardContentFn;
  private readonly finalize: CardFinalizeFn;
  private readonly fallback: OutboundSink;
  private readonly elementId: string;
  private readonly minEditIntervalMs: number;
  private readonly minIntervalMs: number;
  private readonly enableToolHint: boolean;
  private readonly toolHint: (meta?: SegmentBreak) => string;
  private readonly cardSummary: (body: string) => string;
  private readonly log: (msg: string) => void;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly keyOf: (chatId: string, text: string) => string;
  private readonly fallbackStreams: boolean;

  private stopped = false;

  // ── streaming state (one turn at a time) ───────────────────────────────────
  /** Latest full accumulated turn text the channel wants shown. */
  private streamPending?: string;
  /** A turn boundary was requested: finalize after the latest text is shown. */
  private streamCommitting = false;
  /** An in-turn segment boundary (tool call) was requested: seal the current card, keep the turn. */
  private streamSegmentBreaking = false;
  private streamBreakMeta?: SegmentBreak;
  /** Tool-call hint shown as the FIRST line of the current segment's card (undefined => no hint, the
   *  turn's opening segment). Cosmetic only: it prefixes the displayed content but is NOT part of the
   *  turn text, so it never affects offsets or what the text fallback re-sends. */
  private currentHint?: string;
  /** The card being grown right now (undefined => next op creates a fresh one). */
  private live?: LiveCard;
  /** Chars already sealed into PRIOR cards of THIS turn (cross-card rollover). */
  private streamBaseOffset = 0;
  /** Monotonic sequence counter — strictly increasing across the whole sender lifetime, which is
   *  also strictly increasing within every card it ever touches. */
  private sequence = 0;
  /** Timestamp of the last create/edit/finalize, for throttling. */
  private lastEditAt = 0;
  /** A driver loop is running. */
  private streamBusy = false;

  // ── degraded (text fallback) state ─────────────────────────────────────────
  /** CardKit failed this turn; the remainder is delivered via the text fallback. */
  private fellBack = false;
  /** Char offset (into the full turn text) of the last content confirmed on a card; the fallback
   *  owns everything AFTER it, so nothing is duplicated and nothing is dropped. */
  private fallbackOffset = 0;
  /** Accumulated remainder for a non-streaming fallback, flushed as one send on commit. */
  private fbPending?: string;

  private idleResolvers: (() => void)[] = [];

  constructor(opts: CardSenderOptions) {
    this.chatId = opts.chatId;
    this.create = opts.create;
    this.send = opts.send;
    this.content = opts.content;
    this.finalize = opts.finalize;
    this.fallback = opts.fallback;
    this.elementId = opts.elementId ?? DEFAULT_ELEMENT_ID;
    this.minEditIntervalMs = opts.minEditIntervalMs ?? 250;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.enableToolHint = opts.enableToolHint ?? true;
    this.toolHint = opts.toolHint ?? defaultToolHint;
    this.cardSummary = opts.cardSummary ?? defaultCardSummary;
    this.log = opts.log ?? (() => {});
    this.wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.keyOf = opts.idempotencyKey ?? defaultIdempotencyKey;
    this.fallbackStreams = typeof opts.fallback.streamUpdate === "function" && typeof opts.fallback.streamCommit === "function";
  }

  /** One-shot plain text (command replies, error notices). These are never cards — forward to the
   *  text sender directly. */
  enqueue(text: string, key?: string): void {
    if (this.stopped) return;
    this.fallback.enqueue(text, key);
  }

  /** Push the latest full accumulated turn text; the live card is edited in place. */
  streamUpdate(fullText: string): void {
    if (this.stopped) return;
    this.streamPending = fullText; // always track latest, even in fallback mode (anchors offsets)
    if (this.fellBack) {
      this.forwardFallback(fullText);
      return;
    }
    void this.driveStream();
  }

  /** In-turn boundary (tool call): seal the current card and keep the SAME turn going so the next
   *  text opens a fresh card. A no-op when there is nothing shown yet (never leaves an empty card). */
  streamSegmentBreak(meta?: SegmentBreak): void {
    if (this.stopped) return;
    if (this.fellBack) {
      this.forwardFallbackSegmentBreak();
      return;
    }
    this.streamSegmentBreaking = true;
    this.streamBreakMeta = meta;
    void this.driveStream();
  }

  /** Turn boundary: show the latest text, finalize the card, and reset for the next turn. */
  streamCommit(): void {
    if (this.stopped) return;
    if (this.fellBack) {
      this.forwardFallbackCommit();
      return;
    }
    this.streamCommitting = true;
    void this.driveStream();
  }

  whenIdle(): Promise<void> {
    const mine = this.streamBusy ? new Promise<void>((r) => this.idleResolvers.push(r)) : Promise.resolve();
    return mine.then(() => {
      const fb = this.fallback as { whenIdle?: () => Promise<void> };
      return fb.whenIdle ? fb.whenIdle() : undefined;
    });
  }

  stop(): void {
    this.stopped = true;
    this.resetTurn();
    this.fallback.stop();
  }

  // ── driver ──────────────────────────────────────────────────────────────────

  /** Single serial driver: coalesces pending text, throttles edits, finalizes on commit, and
   *  hands off to the fallback the moment CardKit fails. Only one instance runs at a time. */
  private async driveStream(): Promise<void> {
    if (this.streamBusy) return;
    this.streamBusy = true;
    try {
      while (!this.stopped) {
        // CardKit gave up mid-turn: drain the rest of the turn through the text fallback.
        if (this.fellBack) {
          this.forwardFallback(this.streamPending ?? "");
          if (this.streamSegmentBreaking) {
            this.streamSegmentBreaking = false;
            this.streamBreakMeta = undefined;
            this.forwardFallbackSegmentBreak();
          }
          if (this.streamCommitting) this.forwardFallbackCommit();
          break;
        }

        const full = this.streamPending ?? "";
        const body = full.slice(this.streamBaseOffset);
        // Lazy: an armed hint alone does NOT force a card mid-stream — it prefixes the next card that
        // body warrants. Only at a boundary (below) is a hint-only card materialized.
        const liveUpToDate = this.live ? this.live.sentText === body : body.trim() === "";

        if (!liveUpToDate) {
          // Throttle: coalesce mid-stream edits; on a boundary only honor the hard rate limit.
          const minGap = this.streamCommitting || this.streamSegmentBreaking ? this.minIntervalMs : this.minEditIntervalMs;
          const waitMs = this.lastEditAt + minGap - this.now();
          if (waitMs > 0) {
            await this.wait(waitMs);
            continue; // re-read pending so the latest text wins
          }
          await this.doStreamOp(full);
          continue; // re-loop; the op may have triggered a fallback
        }

        // At a boundary with a hint armed but no body/card: materialize a hint-only card so the tool
        // call is still surfaced, then loop to finalize it.
        if ((this.streamSegmentBreaking || this.streamCommitting) && !this.live && this.currentHint !== undefined) {
          const waitMs = this.lastEditAt + this.minIntervalMs - this.now();
          if (waitMs > 0) {
            await this.wait(waitMs);
            continue;
          }
          await this.doStreamOp(full);
          continue;
        }

        // The card (if any) matches the current segment. Process any pending boundary.
        if (this.streamSegmentBreaking) {
          if (this.live) {
            const waitMs = this.lastEditAt + this.minIntervalMs - this.now();
            if (waitMs > 0) {
              await this.wait(waitMs);
              continue;
            }
            await this.finalizeCurrentCard("segment_break"); // seals the just-finished segment's card
          }
          // Arm the hint for the NEXT segment so it shows as that card's first line.
          this.currentHint = this.toolHintFor(this.streamBreakMeta);
          this.streamSegmentBreaking = false;
          this.streamBreakMeta = undefined;
          continue; // keep the turn going; subsequent text opens a fresh card
        }

        if (this.streamCommitting) {
          if (this.live) {
            const waitMs = this.lastEditAt + this.minIntervalMs - this.now();
            if (waitMs > 0) {
              await this.wait(waitMs);
              continue;
            }
            await this.finalizeCurrentCard("turn_commit");
          }
          this.resetTurn();
        }
        break; // nothing more to do until the next streamUpdate/segment break/commit
      }
    } finally {
      this.streamBusy = false;
      if (!this.streamBusy) {
        const resolvers = this.idleResolvers;
        this.idleResolvers = [];
        for (const r of resolvers) r();
      }
    }
  }

  /** Perform exactly one streaming op (create+send, or a content edit) toward `full`. */
  private async doStreamOp(full: string): Promise<void> {
    const body = full.slice(this.streamBaseOffset);

    if (!this.live) {
      if (body.trim() === "" && this.currentHint === undefined) return; // nothing to show
      const display = this.composeDisplay(body);
      try {
        const cr = await this.create({ elementId: this.elementId, text: display });
        if (!cr.ok || !cr.cardId) {
          this.lastEditAt = this.now();
          this.log(`feishu card: create failed${codeInfo(cr)}; falling back to text`);
          this.giveUp();
          return;
        }
        const sr = await this.send({ chatId: this.chatId, cardId: cr.cardId, uuid: safeUuid(this.keyOf(this.chatId, display)) });
        this.lastEditAt = this.now();
        if (!sr.ok || !sr.messageId) {
          this.log(`feishu card: send interactive failed${codeInfo(sr)}; falling back to text`);
          this.giveUp();
          return;
        }
        this.live = { cardId: cr.cardId, messageId: sr.messageId, sentText: body };
      } catch (e) {
        this.lastEditAt = this.now();
        this.log(`feishu card: create/send error: ${String(e)}; falling back to text`);
        this.giveUp();
      }
      return;
    }

    if (this.live.sentText === body) return;

    try {
      const seq = this.nextSeq();
      const r = await this.content({ cardId: this.live.cardId, elementId: this.elementId, content: this.composeDisplay(body), sequence: seq, uuid: stableCardKey(this.live.cardId, seq) });
      this.lastEditAt = this.now();
      if (r.ok) {
        this.live.sentText = body;
      } else {
        this.log(`feishu card: content update failed${codeInfo(r)}; falling back to text`);
        this.giveUp();
      }
    } catch (e) {
      this.lastEditAt = this.now();
      this.log(`feishu card: content update error: ${String(e)}; falling back to text`);
      this.giveUp();
    }
  }

  /** Compose the displayed card content: the tool-call hint (if armed for this segment) as the first
   *  line, then the body. Hint-only when there is no body yet. */
  private composeDisplay(body: string): string {
    if (this.currentHint === undefined) return body;
    return body ? `${this.currentHint}\n\n${body}` : this.currentHint;
  }

  /** The hint string for a segment, or undefined when hints are disabled / empty. */
  private toolHintFor(meta?: SegmentBreak): string | undefined {
    if (!this.enableToolHint) return undefined;
    const hint = this.toolHint(meta);
    return hint ? hint : undefined;
  }

  /** Seal the live card: finalize it (streaming off), advance the turn's base offset past its
   *  confirmed body text, clear it, and drop the consumed segment's hint. Used for every reason a
   *  card ends mid-turn or at the turn boundary, so sequence and fallback accounting stay consistent.
   *  The `reason` is currently informational (the seam is uniform across all of them). */
  private async finalizeCurrentCard(_reason: FinalizeReason): Promise<void> {
    const live = this.live;
    if (!live) return;
    await this.doFinalize(live);
    this.streamBaseOffset += live.sentText.length;
    this.live = undefined;
    this.currentHint = undefined; // the sealed segment's hint is consumed
  }

  /** Finalize the live card (streaming_mode=false). The content is already shown, so a failure
   *  here loses nothing — log and move on rather than re-sending. */
  private async doFinalize(live: LiveCard): Promise<void> {
    try {
      const seq = this.nextSeq();
      const r = await this.finalize({ cardId: live.cardId, sequence: seq, uuid: stableCardKey(live.cardId, seq), summary: this.cardSummary(live.sentText) });
      this.lastEditAt = this.now();
      if (!r.ok) this.log(`feishu card: finalize failed${codeInfo(r)}; card left in streaming state`);
    } catch (e) {
      this.lastEditAt = this.now();
      this.log(`feishu card: finalize error: ${String(e)}; card left in streaming state`);
    }
  }

  /** Switch the rest of this turn to the text fallback, anchored after the confirmed card text. */
  private giveUp(): void {
    if (this.fellBack) return;
    this.fellBack = true;
    this.fallbackOffset = this.streamBaseOffset + (this.live?.sentText.length ?? 0);
  }

  private forwardFallback(full: string): void {
    const remainder = full.slice(this.fallbackOffset);
    if (this.fallbackStreams) {
      if (remainder.trim()) this.fallback.streamUpdate!(remainder);
    } else {
      this.fbPending = remainder;
    }
  }

  private forwardFallbackCommit(): void {
    if (this.fallbackStreams) {
      this.fallback.streamCommit!();
    } else if (this.fbPending && this.fbPending.trim()) {
      this.fallback.enqueue(this.fbPending);
    }
    this.resetTurn();
  }

  /** Segment break while degraded: the boundary must split the fallback text too. The turn keeps
   *  going (no resetTurn), with no duplication of what was already shown.
   *  - Preferred: the text sender has its own soft commit (streamSegmentBreak). We keep forwarding
   *    the SAME remainder string (anchor fixed) and let it manage its own per-segment offset.
   *  - Otherwise: seal what we have (streamCommit / enqueue) and advance our anchor so the next
   *    segment is a separate message. */
  private forwardFallbackSegmentBreak(): void {
    if (this.fallbackStreams && typeof this.fallback.streamSegmentBreak === "function") {
      this.fallback.streamSegmentBreak();
      return;
    }
    if (this.fallbackStreams) {
      this.fallback.streamCommit!();
    } else if (this.fbPending && this.fbPending.trim()) {
      this.fallback.enqueue(this.fbPending);
    }
    this.fbPending = undefined;
    this.fallbackOffset = (this.streamPending ?? "").length;
  }

  private nextSeq(): number {
    return ++this.sequence;
  }

  private resetTurn(): void {
    this.streamPending = undefined;
    this.streamCommitting = false;
    this.streamSegmentBreaking = false;
    this.streamBreakMeta = undefined;
    this.currentHint = undefined;
    this.live = undefined;
    this.streamBaseOffset = 0;
    this.fellBack = false;
    this.fallbackOffset = 0;
    this.fbPending = undefined;
  }
}

/** Default tool-call hint copy: one minimal line, tool name only — no params, input, rawOutput, or
 *  details. Centralized so prdmgr can adjust the wording without touching the state machine. Shown
 *  as the first line of the segment's first card. */
export function defaultToolHint(meta?: SegmentBreak): string {
  return meta?.toolName ? `🔧 调用工具：${meta.toolName}` : "🔧 正在调用工具";
}

function codeInfo(r: { code?: number; message?: string }): string {
  return `${r.code !== undefined ? ` (code ${r.code})` : ""}${r.message ? `: ${r.message}` : ""}`;
}

/** Stable idempotency key for a card op: identical (cardId, sequence) always yields the same uuid,
 *  so a retried content/finalize op is de-duplicated by Feishu rather than double-applied. */
export function stableCardKey(cardId: string, sequence: number): string {
  return safeUuid(`${cardId}-${sequence}`);
}

/** Default card summary (chat-list / notification text), derived from the card body. Centralized so
 *  the copy can be tuned later. First line, truncated; a generic line when there is no body yet. */
export function defaultCardSummary(body: string): string {
  const firstLine = (body ?? "").trim().split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "Agent 回复";
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

// ── real CardKit SDK seams ────────────────────────────────────────────────────
// Wiring these into index.ts is a later commit; they exist so the seam is complete and the payload
// shapes are type-checked against the SDK. Exact JSON 2.0 / settings payloads are acceptable-risk
// per the agreed design and need live validation before relying on the card visuals.

/** Build a JSON 2.0 card carrying one streaming markdown element. Declares update_multi (the card is
 *  shared and updated in place), streaming_mode + streaming_config (typewriter animation), and a
 *  summary so the chat list / notification doesn't render empty. */
export function streamingCardJson(elementId: string, text: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast",
      },
      summary: { content: defaultCardSummary(text) },
    },
    body: {
      elements: [{ tag: "markdown", element_id: elementId, content: text }],
    },
  });
}

export function sdkCardCreate(client: lark.Client): CardCreateFn {
  return async (req: CardCreateRequest): Promise<CardCreateResult> => {
    const res = await client.cardkit.v1.card.create({
      data: { type: "card_json", data: streamingCardJson(req.elementId, req.text) },
    });
    const code = res.code ?? 0;
    return { ok: code === 0, code, message: res.msg, cardId: res.data?.card_id };
  };
}

export function sdkCardSend(client: lark.Client): CardSendFn {
  return async (req: CardSendRequest): Promise<CardSendResult> => {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: req.chatId,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: req.cardId } }),
        uuid: req.uuid,
      },
    });
    const code = res.code ?? 0;
    return { ok: code === 0, code, message: res.msg, messageId: res.data?.message_id };
  };
}

export function sdkCardContent(client: lark.Client): CardContentFn {
  return async (req: CardContentRequest): Promise<CardContentResult> => {
    const res = await client.cardkit.v1.cardElement.content({
      path: { card_id: req.cardId, element_id: req.elementId },
      data: { content: req.content, sequence: req.sequence, uuid: req.uuid },
    });
    const code = res.code ?? 0;
    return { ok: code === 0, code, message: res.msg };
  };
}

export function sdkCardFinalize(client: lark.Client): CardFinalizeFn {
  return async (req: CardFinalizeRequest): Promise<CardFinalizeResult> => {
    const res = await client.cardkit.v1.card.settings({
      path: { card_id: req.cardId },
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: req.summary } } }),
        sequence: req.sequence,
        uuid: req.uuid,
      },
    });
    const code = res.code ?? 0;
    return { ok: code === 0, code, message: res.msg };
  };
}
