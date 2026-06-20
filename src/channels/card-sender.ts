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
import { planOutbound, type ImageBoundary } from "./stream-segmenter";

/** Why a card is being finalized. Card finalization is unified through one path so tool-call
 *  boundaries, size rollover, the streaming-window rollover, and the turn boundary all behave
 *  identically w.r.t. sequence management and fallback accounting. */
export type FinalizeReason = "segment_break" | "size_rollover" | "stream_timeout_rollover" | "turn_commit" | "image_boundary";

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
/** Feishu caps a card around 30KB; stay well under it to leave room for the JSON envelope. */
export const DEFAULT_MAX_CARD_BYTES = 28000;
/** Feishu closes a streaming card after ~10 minutes; roll over comfortably before that. */
export const DEFAULT_MAX_CARD_AGE_MS = 9 * 60 * 1000;

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
  /** Max UTF-8 bytes for a single card's displayed content; a turn longer than this rolls onto
   *  further cards (structure-aware). Default {@link DEFAULT_MAX_CARD_BYTES} (conservatively below
   *  Feishu's ~30KB card limit, leaving room for the card envelope). */
  maxCardBytes?: number;
  /** Max age (ms) a streaming card may stay open before it is finalized and the turn continues on a
   *  fresh card. Feishu closes a streaming card after ~10 minutes; default {@link DEFAULT_MAX_CARD_AGE_MS}
   *  stays safely under that. */
  maxCardAgeMs?: number;
  /** Show a small hint on a card when it is sealed by a tool-call segment break. Default true. */
  enableToolHint?: boolean;
  /** Render the tool-call hint shown as the FIRST line of the next segment's card. Centralized so
   *  prdmgr can tune copy. Return "" to suppress. Default {@link defaultToolHint}. */
  toolHint?: (meta?: SegmentBreak) => string;
  /** Derive the card summary (chat-list / notification text) from the card body. Centralized so it
   *  can be tuned later. Default {@link defaultCardSummary}. */
  cardSummary?: (body: string) => string;
  /** Render the markdown shown on the standalone card emitted at an artifact-image boundary (C2). C2
   *  only reserves the position with a placeholder; C3 turns it into the uploaded `img` element.
   *  Default {@link defaultImagePlaceholder}. */
  imagePlaceholder?: (image: ImageBoundary) => string;
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
  private readonly imagePlaceholder: (image: ImageBoundary) => string;
  private readonly maxCardBytes: number;
  private readonly maxCardAgeMs: number;
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
  /** Structure to reopen on the current card after a size rollover split a code block / table
   *  mid-structure (undefined => no continuation). Its displayPrefix repairs the markdown; it is a
   *  display-only prefix, NOT part of the turn text, so it never affects offsets or fallback. */
  private pendingContinuation?: CardContinuation;
  /** The card being grown right now (undefined => next op creates a fresh one). */
  private live?: LiveCard;
  /** When the live card was opened (now()); a card older than maxCardAgeMs rolls over before Feishu
   *  closes its streaming window. */
  private liveOpenedAt = 0;
  /** Chars already sealed into PRIOR cards of THIS turn (cross-card rollover). */
  private streamBaseOffset = 0;
  /** Cap on how far the current prose card may show (C2): the next artifact-image boundary's start, or
   *  a forming `![` token in the open tail. Infinity for a prose-only turn → body == full.slice(base),
   *  i.e. byte-identical to the pre-C2 single-element behavior. Recomputed each driver iteration. */
  private capOffset = Number.POSITIVE_INFINITY;
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
    this.imagePlaceholder = opts.imagePlaceholder ?? defaultImagePlaceholder;
    this.maxCardBytes = opts.maxCardBytes ?? DEFAULT_MAX_CARD_BYTES;
    this.maxCardAgeMs = opts.maxCardAgeMs ?? DEFAULT_MAX_CARD_AGE_MS;
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
        // C2: plan the next artifact-image card boundary + how far prose may safely show now. For a
        // prose-only turn this is { proseCap: full.length } ⇒ body == full.slice(base), i.e. byte-for-byte
        // the pre-C2 single-element behavior. `final` lets a turn-commit flush a trailing image.
        const plan = planOutbound(full, this.streamBaseOffset, { final: this.streamCommitting });
        this.capOffset = plan.proseCap;
        const body = this.bodyOf(full);
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
          // Streaming window: before editing an aged card, finalize it and continue on a fresh one,
          // so Feishu never closes the card's streaming window out from under us.
          if (this.live && this.now() - this.liveOpenedAt >= this.maxCardAgeMs) {
            await this.sealLiveAndContinue("stream_timeout_rollover");
            continue; // re-loop; the tail opens the next card (reopening any structure)
          }
          // Size budget: if the display would exceed the card limit, roll the head onto this card
          // and continue the tail on a fresh one (structure-aware), instead of one giant edit.
          const split = planSizeSplit(body, this.maxCardBytes, this.splitStart());
          if (split) {
            await this.sizeRollOver(split);
            continue; // re-loop; the tail (now full.slice(advanced offset)) opens the next card
          }
          await this.doStreamOp(full);
          continue; // re-loop; the op may have triggered a fallback
        }

        // C2: the prose up to the next artifact image is fully shown (or there is none before it) → seal
        // the prose card, send a standalone image/placeholder card, and advance PAST the image token so
        // prose continues on a fresh card. Reuses the existing seal/offset machinery (Opt-2: images are
        // card boundaries, not same-card elements). A failed image op degrades to text like any other op.
        if (plan.image) {
          if (this.live) {
            const minGap = this.streamCommitting || this.streamSegmentBreaking ? this.minIntervalMs : this.minEditIntervalMs;
            const waitMs = this.lastEditAt + minGap - this.now();
            if (waitMs > 0) {
              await this.wait(waitMs);
              continue;
            }
            await this.finalizeCurrentCard("image_boundary"); // seals prose card; advances base to image.start
          }
          if (await this.emitImageCard(plan.image)) this.streamBaseOffset = plan.image.end; // skip the token text
          continue; // a failed emit fell back (drains next loop); otherwise prose continues on a fresh card
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

  /** The prose body the current card may show: from the turn's cross-card base up to the C2 image cap. */
  private bodyOf(full: string): string {
    return full.slice(this.streamBaseOffset, this.capOffset < full.length ? this.capOffset : full.length);
  }

  /** Emit a standalone card at an artifact-image boundary (C2): create + send + finalize a static card
   *  carrying the image placeholder. C3 replaces the placeholder with the uploaded `img` element. On any
   *  failed op, degrade to the text fallback (the remainder, incl. the literal image markdown, is never
   *  lost). Returns true iff the placeholder card was sent. */
  private async emitImageCard(image: ImageBoundary): Promise<boolean> {
    const text = this.imagePlaceholder(image);
    try {
      const cr = await this.create({ elementId: this.elementId, text });
      if (!cr.ok || !cr.cardId) {
        this.lastEditAt = this.now();
        this.log(`feishu card: image placeholder create failed${codeInfo(cr)}; falling back to text`);
        this.giveUp();
        return false;
      }
      const sr = await this.send({ chatId: this.chatId, cardId: cr.cardId, uuid: cardSendUuid(cr.cardId) });
      this.lastEditAt = this.now();
      if (!sr.ok || !sr.messageId) {
        this.log(`feishu card: image placeholder send failed${codeInfo(sr)}; falling back to text`);
        this.giveUp();
        return false;
      }
      const seq = this.nextSeq();
      const r = await this.finalize({ cardId: cr.cardId, sequence: seq, uuid: stableCardKey(cr.cardId, seq), summary: this.cardSummary(text) });
      this.lastEditAt = this.now();
      if (!r.ok) this.log(`feishu card: image placeholder finalize failed${codeInfo(r)}; left in streaming state`);
      return true;
    } catch (e) {
      this.lastEditAt = this.now();
      this.log(`feishu card: image placeholder error: ${String(e)}; falling back to text`);
      this.giveUp();
      return false;
    }
  }

  /** Perform exactly one streaming op (create+send, or a content edit) toward `full`. */
  private async doStreamOp(full: string): Promise<void> {
    const body = this.bodyOf(full);

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
        const sr = await this.send({ chatId: this.chatId, cardId: cr.cardId, uuid: cardSendUuid(cr.cardId) });
        this.lastEditAt = this.now();
        if (!sr.ok || !sr.messageId) {
          this.log(`feishu card: send interactive failed${codeInfo(sr)}; falling back to text`);
          this.giveUp();
          return;
        }
        this.live = { cardId: cr.cardId, messageId: sr.messageId, sentText: body };
        this.liveOpenedAt = this.now();
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

  /** Size rollover: show `headText` (+ a closing fence if a code block was cut) on the current card,
   *  seal it via the unified finalize path, then arm the continuation so the tail opens a fresh card
   *  that reopens the fence / resends the table header. Only `headText` (real turn body) advances the
   *  offset; the close fence is display-only. A failed op falls back to text from the confirmed point. */
  private async sizeRollOver(split: CardSizeSplit): Promise<void> {
    // Monotonic display: never rewrite the live card to SHORTER text. If the optimal split head is
    // shorter than what's already shown (a card filled to budget then grew), seal the live card
    // as-is and continue the tail on a fresh card — no backward edit.
    if (this.live && split.headText.length < this.live.sentText.length) {
      const shownBytes = byteLen(this.composeDisplay(this.live.sentText));
      if (shownBytes > this.maxCardBytes) {
        this.log(`feishu card: soft over-budget rollover (${shownBytes}B > ${this.maxCardBytes}B); sealing without shrinking`);
      }
      await this.sealLiveAndContinue("size_rollover");
      return;
    }
    const headDisplay = appendCloseFence(this.composeDisplay(split.headText), split.closeFence);
    if (!this.live) {
      try {
        const cr = await this.create({ elementId: this.elementId, text: headDisplay });
        if (!cr.ok || !cr.cardId) {
          this.lastEditAt = this.now();
          this.log(`feishu card: create failed${codeInfo(cr)}; falling back to text`);
          this.giveUp();
          return;
        }
        const sr = await this.send({ chatId: this.chatId, cardId: cr.cardId, uuid: cardSendUuid(cr.cardId) });
        this.lastEditAt = this.now();
        if (!sr.ok || !sr.messageId) {
          this.log(`feishu card: send interactive failed${codeInfo(sr)}; falling back to text`);
          this.giveUp();
          return;
        }
        this.live = { cardId: cr.cardId, messageId: sr.messageId, sentText: split.headText };
        this.liveOpenedAt = this.now();
      } catch (e) {
        this.lastEditAt = this.now();
        this.log(`feishu card: create/send error: ${String(e)}; falling back to text`);
        this.giveUp();
        return;
      }
    } else if (this.live.sentText !== split.headText) {
      try {
        const seq = this.nextSeq();
        const r = await this.content({ cardId: this.live.cardId, elementId: this.elementId, content: headDisplay, sequence: seq, uuid: stableCardKey(this.live.cardId, seq) });
        this.lastEditAt = this.now();
        if (!r.ok) {
          this.log(`feishu card: content update failed${codeInfo(r)}; falling back to text`);
          this.giveUp();
          return;
        }
        this.live.sentText = split.headText;
      } catch (e) {
        this.lastEditAt = this.now();
        this.log(`feishu card: content update error: ${String(e)}; falling back to text`);
        this.giveUp();
        return;
      }
    }
    await this.finalizeCurrentCard("size_rollover"); // advances offset by headText.length; clears hint/continuation
    this.pendingContinuation = split.continuation; // arm the tail's reopen prefix (undefined => clean)
  }

  /** Seal the live card without a backward edit and continue the SAME turn on a fresh card, repairing
   *  any structure the sealed text left open. Used when a card must end without a planned split point:
   *  the monotonic-display shrink guard and the streaming-window timeout rollover.
   *  If the sealed text leaves a code fence open, APPEND the matching close marker (display-only,
   *  append-only — never a backward shrink; live.sentText stays the confirmed body) so the finalized
   *  card is balanced, then reopen the fence on the next card. Tables need no close, only the header
   *  resend on the next card. */
  private async sealLiveAndContinue(reason: FinalizeReason): Promise<void> {
    const live = this.live;
    if (!live) return;
    const ctx = continuationAfter(live.sentText, { openFence: this.pendingContinuation?.openFence, tableHeader: this.pendingContinuation?.tableHeader });
    if (ctx?.openFence) {
      // Close the open code block on the current card (append-only; do NOT touch live.sentText).
      const display = appendCloseFence(this.composeDisplay(live.sentText), fenceMarkerOf(ctx.openFence));
      try {
        const seq = this.nextSeq();
        const r = await this.content({ cardId: live.cardId, elementId: this.elementId, content: display, sequence: seq, uuid: stableCardKey(live.cardId, seq) });
        this.lastEditAt = this.now();
        if (!r.ok) this.log(`feishu card: close-fence edit failed${codeInfo(r)}; sealing card unbalanced`);
      } catch (e) {
        this.lastEditAt = this.now();
        this.log(`feishu card: close-fence edit error: ${String(e)}; sealing card unbalanced`);
      }
      // A failed close is cosmetic (body already shown) — do not give up or re-send confirmed body.
    }
    await this.finalizeCurrentCard(reason); // advances by live.sentText.length; clears hint/continuation
    this.pendingContinuation = ctx; // reopen any fence/table the sealed text left open
  }

  /** Compose the displayed card content. Deterministic order: the tool-call hint (first line of a
   *  segment's opening card) OR a size-rollover continuation prefix (reopened fence / resent table
   *  header that repairs the markdown), then the body. Hint and continuation never co-occur on the
   *  same card: sealing a card consumes both. Hint-only when there is no body yet. */
  private composeDisplay(body: string): string {
    if (this.currentHint !== undefined) return body ? `${this.currentHint}\n\n${body}` : this.currentHint;
    if (this.pendingContinuation !== undefined) return this.pendingContinuation.displayPrefix + body;
    return body;
  }

  /** The display prefix bytes the current card carries before its body — passed to planSizeSplit so
   *  the budget accounts for the hint / continuation, and the structural carry for repair. */
  private splitStart(): { displayPrefix: string; openFence?: string; tableHeader?: string } {
    const displayPrefix = this.currentHint !== undefined
      ? `${this.currentHint}\n\n`
      : this.pendingContinuation?.displayPrefix ?? "";
    return { displayPrefix, openFence: this.pendingContinuation?.openFence, tableHeader: this.pendingContinuation?.tableHeader };
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
    this.currentHint = undefined; // the sealed card's hint is consumed
    this.pendingContinuation = undefined; // and its continuation prefix
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
    this.pendingContinuation = undefined;
    this.live = undefined;
    this.streamBaseOffset = 0;
    this.capOffset = Number.POSITIVE_INFINITY;
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

/** Default placeholder markdown for the standalone card emitted at an artifact-image boundary (C2). C3
 *  replaces this with the uploaded `img` element; the artifact ref is intentionally not shown. */
export function defaultImagePlaceholder(image: ImageBoundary): string {
  return image.alt ? `🖼 ${image.alt}` : "🖼 image";
}

function codeInfo(r: { code?: number; message?: string }): string {
  return `${r.code !== undefined ? ` (code ${r.code})` : ""}${r.message ? `: ${r.message}` : ""}`;
}

/** Unique idempotency key for the ONE interactive message that sends a card. Keyed on the card id
 *  (unique per card create), so two cards with identical display text still get distinct send uuids
 *  and Feishu doesn't dedupe the second message as a retry. */
function cardSendUuid(cardId: string): string {
  return safeUuid(`${cardId}-send`);
}

/** Append a closing fence to a card's display, guaranteeing it sits on its own line (never glued to
 *  the end of a code line, which would not close the block). No-op when there is no fence to close. */
function appendCloseFence(display: string, closeFence: string): string {
  if (!closeFence) return display;
  return `${display}${display.endsWith("\n") ? "" : "\n"}${closeFence}`;
}

/** UTF-8 byte length — card budgets are bytes, not JS string units. */
export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

const FENCE_RE = /^\s*(```|~~~)(.*)$/;

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

/** A markdown table delimiter row, e.g. `| --- | :--: |` / `---|---`. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-")) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
}

/** What a card is structurally in the middle of, so a continued card can reopen it. */
export interface CardContinuation {
  /** Display text prepended to the next card's body (reopened fence / resent table header). */
  displayPrefix: string;
  /** The opening fence to reopen if the next card continues an open code block. */
  openFence?: string;
  /** The header+separator rows to resend if the next card continues a table. */
  tableHeader?: string;
}

export interface CardSizeSplit {
  /** Prefix of `body` to keep on the current card; ends at a line boundary (trailing "\n"). */
  headText: string;
  /** "" or "```"/"~~~" — appended after headText to close an open code block on the current card. */
  closeFence: string;
  /** Structure to reopen on the next card; absent for a clean boundary split. */
  continuation?: CardContinuation;
}

/** Bare fence marker (``` or ~~~) of a reopen token like "```js" / "~~~". */
function fenceMarkerOf(fence: string): string {
  return fence.trimStart().startsWith("~~~") ? "~~~" : "```";
}

/** Largest code-point-aligned prefix of `text` whose UTF-8 byte length is <= budget. Iterating with
 *  for..of yields whole code points, so multi-byte chars / emoji are never split mid-sequence. */
function takeByBytes(text: string, budget: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const cb = byteLen(ch);
    if (bytes + cb > budget) break;
    out += ch;
    bytes += cb;
  }
  return out;
}

/** Plan a structure-aware split of `body` so the current card's DISPLAY (inherited prefix + head +
 *  optional close fence) stays under `budgetBytes` (UTF-8). Splits are preferred at blank-line, then
 *  any line boundary OUTSIDE code fences and tables; a code block / table larger than the budget is
 *  split at a line boundary with the fence closed+reopened (same marker) or the table header resent.
 *  A single line larger than the budget is split UTF-8-safely at a code-point boundary (still a true
 *  prefix of `body`). `start` carries the current card's display prefix (for budgeting) and any open
 *  fence / table header inherited from a prior continued card (so multi-card structures keep
 *  repairing). Returns null when the prefix + body already fit. */
export function planSizeSplit(
  body: string,
  budgetBytes: number,
  start?: { displayPrefix?: string; openFence?: string; tableHeader?: string },
): CardSizeSplit | null {
  const inheritedPrefix = start?.displayPrefix
    ?? (start?.openFence ? `${start.openFence}\n` : start?.tableHeader ? `${start.tableHeader}\n` : "");
  const prefixBytes = byteLen(inheritedPrefix);
  if (prefixBytes + byteLen(body) <= budgetBytes) return null;

  const lines = body.split("\n");
  let inFence = !!start?.openFence;
  let fenceReopen = start?.openFence ?? "";
  let fenceMarker = start?.openFence ? fenceMarkerOf(start.openFence) : "```";
  let tableHeader = start?.tableHeader ?? "";
  let bytes = prefixBytes; // the display already carries the inherited prefix
  let safeEnd = -1; // blank-line boundary outside structures (best)
  let anyEnd = -1; // any line boundary outside structures
  let forcedEnd = -1;
  let forcedClose = "";
  let forcedReopen: CardContinuation | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = (i === 0 ? 0 : 1) + byteLen(line); // include the joining "\n"
    // Reserve room for what the head display appends: a closing fence (with its newline) inside a
    // code block, or just the head's own trailing newline otherwise.
    const reserve = inFence ? byteLen(`\n${fenceMarker}`) : 1;
    if (i > 0 && bytes + lineBytes + reserve > budgetBytes) {
      forcedEnd = i - 1;
      if (inFence) {
        forcedClose = fenceMarker;
        forcedReopen = { displayPrefix: `${fenceReopen}\n`, openFence: fenceReopen };
      } else if (tableHeader) {
        forcedReopen = { displayPrefix: `${tableHeader}\n`, tableHeader };
      }
      break;
    }
    bytes += lineBytes;

    const fm = line.match(FENCE_RE);
    if (fm) {
      if (!inFence) { inFence = true; fenceReopen = fm[1] + (fm[2] ?? ""); fenceMarker = fm[1]; }
      else { inFence = false; fenceReopen = ""; }
    } else if (!inFence) {
      if (tableHeader) {
        if (!isTableRow(line)) tableHeader = ""; // table ended
      } else if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        tableHeader = `${line}\n${lines[i + 1]}`;
      }
    }

    if (!inFence && !tableHeader) {
      anyEnd = i;
      if (line.trim() === "") safeEnd = i;
    }
  }

  let end = -1;
  let closeFence = "";
  let continuation: CardContinuation | undefined;
  if (safeEnd >= 0) end = safeEnd;
  else if (anyEnd >= 0) end = anyEnd;
  else if (forcedEnd >= 0) { end = forcedEnd; closeFence = forcedClose; continuation = forcedReopen; }
  if (end > lines.length - 2) end = lines.length - 2; // always leave a tail

  if (end >= 0) {
    const headText = `${lines.slice(0, end + 1).join("\n")}\n`;
    // A clean line-boundary head that fits the display budget and leaves a tail wins.
    if (headText.length < body.length && prefixBytes + byteLen(headText) + byteLen(closeFence) <= budgetBytes) {
      return { headText, closeFence, continuation };
    }
  }

  // Degenerate: no usable line boundary (e.g. a single line larger than the budget). Split the body
  // UTF-8-safely at a code-point boundary inside the current structural context, repairing fences /
  // tables so the head card and the continued card both render.
  const ctxInFence = !!start?.openFence;
  const ctxFenceMarker = start?.openFence ? fenceMarkerOf(start.openFence) : "```";
  const close = ctxInFence ? ctxFenceMarker : "";
  const closeBytes = close ? byteLen(`\n${close}`) : 0;
  const avail = budgetBytes - prefixBytes - closeBytes;
  let head = takeByBytes(body, avail);
  if (head.length === 0) head = firstCodePoint(body); // guarantee progress (>= 1 code point)
  if (head.length >= body.length) {
    // took everything — back off one code point so there is a tail to continue
    const backed = head.slice(0, head.length - lastCodePointLen(head));
    head = backed.length > 0 ? backed : firstCodePoint(body);
  }
  const degenerateContinuation: CardContinuation | undefined = ctxInFence
    ? { displayPrefix: `${start!.openFence}\n`, openFence: start!.openFence }
    : start?.tableHeader
      ? { displayPrefix: `${start.tableHeader}\n`, tableHeader: start.tableHeader }
      : undefined;
  return { headText: head, closeFence: close, continuation: degenerateContinuation };
}

/** The structure still open at the END of `text` (scanned from an inherited `start` state) — used to
 *  reopen a fence / resend a table header on the next card when a card is sealed as-is (shrink guard)
 *  rather than at a planned split boundary. */
function continuationAfter(text: string, start?: { openFence?: string; tableHeader?: string }): CardContinuation | undefined {
  let inFence = !!start?.openFence;
  let fenceReopen = start?.openFence ?? "";
  let tableHeader = start?.tableHeader ?? "";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(FENCE_RE);
    if (fm) {
      if (!inFence) { inFence = true; fenceReopen = fm[1] + (fm[2] ?? ""); }
      else { inFence = false; fenceReopen = ""; }
    } else if (!inFence) {
      if (tableHeader) { if (!isTableRow(line)) tableHeader = ""; }
      else if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        tableHeader = `${line}\n${lines[i + 1]}`;
      }
    }
  }
  if (inFence) return { displayPrefix: `${fenceReopen}\n`, openFence: fenceReopen };
  if (tableHeader) return { displayPrefix: `${tableHeader}\n`, tableHeader };
  return undefined;
}

function firstCodePoint(s: string): string {
  for (const ch of s) return ch;
  return "";
}

function lastCodePointLen(s: string): number {
  let last = "";
  for (const ch of s) last = ch;
  return last.length;
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
