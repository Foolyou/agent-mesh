import { test, expect } from "bun:test";
import {
  CardSender,
  streamingCardJson,
  defaultCardSummary,
  stableCardKey,
  sdkCardCreate,
  sdkCardContent,
  sdkCardFinalize,
  planSizeSplit,
  byteLen,
  type CardCreateRequest,
  type CardCreateResult,
  type CardSendRequest,
  type CardSendResult,
  type CardContentRequest,
  type CardContentResult,
  type CardFinalizeRequest,
  type CardFinalizeResult,
} from "./card-sender";
import type { OutboundSink } from "./feishu-channel";
import { LarkSender, type SendRequest, type SendResult, type UpdateRequest } from "./sender";

/** CardKit transport recorder with a virtual clock so edit throttling is deterministic.
 *  `wait(ms)` advances time. Each op's impl can override the default success. */
function cardRecorder(opts?: {
  createImpl?: (req: CardCreateRequest, n: number) => CardCreateResult;
  sendImpl?: (req: CardSendRequest, n: number) => CardSendResult;
  contentImpl?: (req: CardContentRequest, n: number) => CardContentResult;
  finalizeImpl?: (req: CardFinalizeRequest, n: number) => CardFinalizeResult;
}) {
  const creates: CardCreateRequest[] = [];
  const sends: CardSendRequest[] = [];
  const contents: CardContentRequest[] = [];
  const finalizes: CardFinalizeRequest[] = [];
  /** Every sequenced op (content + finalize) in chronological call order. */
  const seqLog: number[] = [];
  let cardN = 0;
  let msgN = 0;
  let cN = 0;
  let sN = 0;
  let conN = 0;
  let finN = 0;
  let t = 1_000_000;
  const create = async (req: CardCreateRequest): Promise<CardCreateResult> => {
    creates.push(req);
    return opts?.createImpl ? opts.createImpl(req, ++cN) : { ok: true, cardId: `card${++cardN}` };
  };
  const send = async (req: CardSendRequest): Promise<CardSendResult> => {
    sends.push(req);
    return opts?.sendImpl ? opts.sendImpl(req, ++sN) : { ok: true, messageId: `m${++msgN}` };
  };
  const content = async (req: CardContentRequest): Promise<CardContentResult> => {
    contents.push(req);
    seqLog.push(req.sequence);
    return opts?.contentImpl ? opts.contentImpl(req, ++conN) : { ok: true };
  };
  const finalize = async (req: CardFinalizeRequest): Promise<CardFinalizeResult> => {
    finalizes.push(req);
    seqLog.push(req.sequence);
    return opts?.finalizeImpl ? opts.finalizeImpl(req, ++finN) : { ok: true };
  };
  const now = () => t;
  const wait = async (ms: number) => {
    t += ms;
  };
  const advance = (ms: number) => {
    t += ms;
  };
  return { creates, sends, contents, finalizes, seqLog, create, send, content, finalize, now, wait, advance };
}

/** A fake text fallback sink (the role real LarkSender plays). */
function fakeFallback(opts?: { streaming?: boolean }) {
  const enqueued: string[] = [];
  const streamUpdates: string[] = [];
  let commits = 0;
  let stopped = 0;
  const sink: OutboundSink = {
    enqueue: (text: string) => {
      enqueued.push(text);
    },
    stop: () => {
      stopped++;
    },
  };
  if (opts?.streaming !== false) {
    sink.streamUpdate = (text: string) => {
      streamUpdates.push(text);
    };
    sink.streamCommit = () => {
      commits++;
    };
  }
  return {
    sink,
    enqueued,
    streamUpdates,
    get commits() {
      return commits;
    },
    get stopped() {
      return stopped;
    },
  };
}

function makeSender(r: ReturnType<typeof cardRecorder>, fb: ReturnType<typeof fakeFallback>, extra?: Partial<{ log: (m: string) => void; minEditIntervalMs: number; enableToolHint: boolean; maxCardBytes: number; maxCardAgeMs: number }>) {
  return new CardSender({
    chatId: "oc_1",
    create: r.create,
    send: r.send,
    content: r.content,
    finalize: r.finalize,
    fallback: fb.sink,
    minEditIntervalMs: extra?.minEditIntervalMs ?? 250,
    enableToolHint: extra?.enableToolHint,
    maxCardBytes: extra?.maxCardBytes,
    maxCardAgeMs: extra?.maxCardAgeMs,
    now: r.now,
    wait: r.wait,
    log: extra?.log,
  });
}

// ── happy path ─────────────────────────────────────────────────────────────────

test("first chunk creates a card and sends one interactive message", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("Hello");
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["Hello"]);
  expect(r.sends).toHaveLength(1);
  expect(r.sends[0].chatId).toBe("oc_1");
  expect(r.sends[0].cardId).toBe("card1");
  expect(r.sends[0].uuid).toBeTruthy();
  expect(r.contents).toHaveLength(0); // initial content rides the create, no extra edit yet
});

test("later chunks edit the card content in place via the content endpoint", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("Hello");
  await s.whenIdle();
  s.streamUpdate("Hello world");
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["Hello"]); // only one card created
  expect(r.contents.map((c) => c.content)).toEqual(["Hello world"]);
  expect(r.contents[0].cardId).toBe("card1");
  expect(r.contents[0].sequence).toBeGreaterThan(0);
});

test("rapid updates inside the throttle window coalesce into one content edit", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("a");
  await s.whenIdle();
  s.streamUpdate("ab");
  s.streamUpdate("abc");
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["a"]);
  expect(r.contents.map((c) => c.content)).toEqual(["abc"]); // "ab" coalesced away
});

test("commit finalizes the card (streaming off) and the next turn starts a fresh card", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("x");
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["x"]);
  expect(r.finalizes).toHaveLength(1);
  expect(r.finalizes[0].cardId).toBe("card1");
  s.streamUpdate("y");
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["x", "y"]); // second turn => second card
  expect(r.finalizes.map((f) => f.cardId)).toEqual(["card1", "card2"]);
});

test("sequence is strictly increasing across every content + finalize op of a turn", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("1");
  await s.whenIdle();
  s.streamUpdate("12");
  await s.whenIdle();
  s.streamUpdate("123");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  const seqs = [...r.contents.map((c) => c.sequence), ...r.finalizes.map((f) => f.sequence)];
  expect(seqs.length).toBeGreaterThanOrEqual(3);
  const sorted = [...seqs].sort((a, b) => a - b);
  expect(seqs).toEqual(sorted); // monotonic non-decreasing in op order
  expect(new Set(seqs).size).toBe(seqs.length); // and strictly: no repeats
});

// ── one-shot enqueue ─────────────────────────────────────────────────────────────

test("enqueue forwards plain text straight to the fallback sender", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.enqueue("mesh status: running");
  expect(fb.enqueued).toEqual(["mesh status: running"]);
  expect(r.creates).toHaveLength(0);
});

// ── degraded continuation (the critical anti-loss path) ──────────────────────────

test("create failure falls back to text with the whole reply (no card sent)", async () => {
  const r = cardRecorder({ createImpl: () => ({ ok: false, code: 1, message: "boom" }) });
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("Hello world");
  await s.whenIdle();
  expect(r.sends).toHaveLength(0);
  expect(fb.streamUpdates).toEqual(["Hello world"]);
  s.streamCommit();
  await s.whenIdle();
  expect(fb.commits).toBe(1);
});

test("send (interactive) failure falls back to text with the whole reply", async () => {
  const r = cardRecorder({ sendImpl: () => ({ ok: false, code: 1 }) });
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("Hello world");
  await s.whenIdle();
  expect(r.creates).toHaveLength(1); // card entity was created...
  expect(fb.streamUpdates).toEqual(["Hello world"]); // ...but never shown, so resend whole text
});

test("a mid-turn content failure falls back from AFTER the confirmed text — no dup, no loss", async () => {
  // first content edit fails; everything already shown on the card stays, the remainder streams via text.
  const r = cardRecorder({ contentImpl: (_req, n) => (n === 1 ? { ok: false, code: 99 } : { ok: true }) });
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("Hello"); // confirmed on the card
  await s.whenIdle();
  s.streamUpdate("Hello world"); // content edit #1 fails -> give up, fall back from offset 5
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["Hello"]);
  expect(fb.streamUpdates).toEqual([" world"]); // only the not-yet-shown remainder
  s.streamUpdate("Hello world!!!"); // keeps flowing through the fallback for the rest of the turn
  await s.whenIdle();
  expect(fb.streamUpdates).toEqual([" world", " world!!!"]);
  s.streamCommit();
  await s.whenIdle();
  expect(fb.commits).toBe(1);
  // next turn recovers and tries cards again
  s.streamUpdate("next turn");
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["Hello", "next turn"]);
});

test("a 300317 sequence error falls back to text from the confirmed point", async () => {
  const r = cardRecorder({ contentImpl: () => ({ ok: false, code: 300317 }) });
  const fb = fakeFallback();
  const logs: string[] = [];
  const s = makeSender(r, fb, { log: (m) => logs.push(m) });
  s.streamUpdate("Hi");
  await s.whenIdle();
  s.streamUpdate("Hi there");
  await s.whenIdle();
  expect(fb.streamUpdates).toEqual([" there"]);
  expect(logs.some((l) => l.includes("300317"))).toBe(true);
});

test("non-streaming fallback delivers the remainder as one ordinary send on commit", async () => {
  const r = cardRecorder({ createImpl: () => ({ ok: false, code: 1 }) });
  const fb = fakeFallback({ streaming: false });
  const s = makeSender(r, fb);
  s.streamUpdate("Hello");
  s.streamUpdate("Hello world");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(fb.enqueued).toEqual(["Hello world"]);
  expect(fb.streamUpdates).toEqual([]);
});

test("finalize failure does NOT lose or duplicate the reply (content is already shown)", async () => {
  const r = cardRecorder({ finalizeImpl: () => ({ ok: false, code: 1, message: "nope" }) });
  const fb = fakeFallback();
  const logs: string[] = [];
  const s = makeSender(r, fb, { log: (m) => logs.push(m) });
  s.streamUpdate("Done");
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["Done"]); // shown on the card
  expect(r.finalizes).toHaveLength(1);
  expect(fb.streamUpdates).toEqual([]); // no fallback dup
  expect(fb.enqueued).toEqual([]);
  expect(logs.some((l) => l.toLowerCase().includes("finalize"))).toBe(true);
  // a failed finalize must not wedge the next turn
  s.streamUpdate("Again");
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["Done", "Again"]);
});

// ── in-turn segmentation (tool-call boundaries) ─────────────────────────────────

test("a segment break finalizes the current card and following text opens a fresh card", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false });
  s.streamUpdate("Before tool");
  await s.whenIdle();
  s.streamSegmentBreak({ toolName: "bash" });
  await s.whenIdle();
  // full turn text keeps the prefix; the sink shows only the new tail on the next card
  s.streamUpdate("Before toolAfter tool");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["Before tool", "After tool"]);
  expect(r.finalizes.map((f) => f.cardId)).toEqual(["card1", "card2"]);
});

test("multiple tool calls in one turn produce one card per segment", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false });
  s.streamUpdate("seg1");
  await s.whenIdle();
  s.streamSegmentBreak({ toolName: "t1" });
  await s.whenIdle();
  s.streamUpdate("seg1seg2");
  await s.whenIdle();
  s.streamSegmentBreak({ toolName: "t2" });
  await s.whenIdle();
  s.streamUpdate("seg1seg2seg3");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["seg1", "seg2", "seg3"]);
  expect(r.finalizes.map((f) => f.cardId)).toEqual(["card1", "card2", "card3"]);
});

test("a tool call with no following text leaves no empty card", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false });
  s.streamUpdate("only text");
  await s.whenIdle();
  s.streamSegmentBreak({ toolName: "t" });
  await s.whenIdle();
  s.streamCommit(); // turn ends with no further text
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["only text"]);
  expect(r.finalizes).toHaveLength(1); // only the one real card was finalized
});

test("a segment break before any text creates no card", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false });
  s.streamSegmentBreak({ toolName: "t" });
  await s.whenIdle();
  s.streamUpdate("text after");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["text after"]);
  expect(r.finalizes).toHaveLength(1);
});

test("sequence stays strictly increasing across tool-call segments (never resets)", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false });
  s.streamUpdate("a");
  await s.whenIdle();
  s.streamUpdate("ab");
  await s.whenIdle();
  s.streamSegmentBreak();
  await s.whenIdle();
  s.streamUpdate("abc");
  await s.whenIdle();
  s.streamUpdate("abcd");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.seqLog.length).toBeGreaterThanOrEqual(4);
  const sorted = [...r.seqLog].sort((a, b) => a - b);
  expect(r.seqLog).toEqual(sorted); // chronological order is monotonic
  expect(new Set(r.seqLog).size).toBe(r.seqLog.length); // strictly: no repeats
});

test("tool hint (default on) prefixes the NEXT segment's card as its first line", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb); // hint default on
  s.streamUpdate("working");
  await s.whenIdle();
  s.streamSegmentBreak({ toolName: "bash" });
  await s.whenIdle();
  s.streamUpdate("workingafter");
  await s.whenIdle();
  expect(r.creates[0].text).toBe("working"); // opening segment: no hint
  expect(r.creates[1].text).toBe("🔧 调用工具：bash\n\nafter"); // tool name only, first line
});

test("tool hint (default on): a tool call with no following text emits a hint-only card", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb); // hint default on
  s.streamUpdate("done");
  await s.whenIdle();
  s.streamSegmentBreak({ toolName: "grep" });
  await s.whenIdle();
  s.streamCommit(); // turn ends with no body after the tool call
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["done", "🔧 调用工具：grep"]);
  expect(r.finalizes).toHaveLength(2); // the hint-only card is finalized too
});

test("tool hint falls back to a generic line when the tool name is missing", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("x");
  await s.whenIdle();
  s.streamSegmentBreak(); // no meta
  await s.whenIdle();
  s.streamUpdate("xy");
  await s.whenIdle();
  expect(r.creates[1].text).toBe("🔧 正在调用工具\n\ny");
});

test("degraded mode segments per tool call: no dup, no loss across the boundary", async () => {
  const r = cardRecorder({ contentImpl: () => ({ ok: false, code: 99 }) });
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false });
  s.streamUpdate("Hello"); // card1 "Hello" created
  await s.whenIdle();
  s.streamUpdate("Hello world"); // content edit fails -> give up, fall back from offset 5
  await s.whenIdle();
  expect(fb.streamUpdates).toEqual([" world"]);
  s.streamSegmentBreak(); // in fallback: seal the text msg, anchor moves to current length
  await s.whenIdle();
  expect(fb.commits).toBe(1);
  s.streamUpdate("Hello worldmore"); // only the new tail goes to a fresh fallback message
  await s.whenIdle();
  expect(fb.streamUpdates).toEqual([" world", "more"]);
  s.streamCommit();
  await s.whenIdle();
  expect(fb.commits).toBe(2);
});

// ── CardKit payload / idempotency ───────────────────────────────────────────────

test("streamingCardJson declares update_multi, streaming_mode, streaming_config and a summary", () => {
  const json = JSON.parse(streamingCardJson("md", "Hello world"));
  expect(json.schema).toBe("2.0");
  expect(json.config.update_multi).toBe(true);
  expect(json.config.streaming_mode).toBe(true);
  expect(json.config.streaming_config).toBeDefined();
  expect(json.config.summary).toBeDefined();
  expect(json.config.summary.content).toBeTruthy();
  const el = json.body.elements[0];
  expect(el.tag).toBe("markdown");
  expect(el.element_id).toBe("md");
  expect(el.content).toBe("Hello world");
});

test("defaultCardSummary uses the first line, truncates long text, falls back when empty", () => {
  expect(defaultCardSummary("short answer")).toBe("short answer");
  expect(defaultCardSummary("line one\nline two")).toBe("line one");
  expect(defaultCardSummary("")).toBeTruthy(); // non-empty generic fallback
  expect(defaultCardSummary("x".repeat(100)).length).toBeLessThanOrEqual(41);
});

test("stableCardKey is deterministic and uuid-safe", () => {
  expect(stableCardKey("card1", 3)).toBe(stableCardKey("card1", 3));
  expect(stableCardKey("card1", 3)).not.toBe(stableCardKey("card1", 4));
  expect(stableCardKey("card1", 3)).not.toBe(stableCardKey("card2", 3));
  expect(stableCardKey("card1", 3)).toMatch(/^[A-Za-z0-9_-]{1,50}$/);
});

test("content and finalize ops carry a stable uuid keyed on cardId + sequence", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false });
  s.streamUpdate("a");
  await s.whenIdle();
  s.streamUpdate("ab");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.contents[0].uuid).toBe(stableCardKey(r.contents[0].cardId, r.contents[0].sequence));
  expect(r.finalizes[0].uuid).toBe(stableCardKey(r.finalizes[0].cardId, r.finalizes[0].sequence));
  expect(r.contents[0].uuid).not.toBe(r.finalizes[0].uuid); // distinct sequences
});

test("finalize updates the card summary derived from the final body", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false });
  s.streamUpdate("Hello world this is the full answer");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.finalizes[0].summary).toBeTruthy();
  expect(r.finalizes[0].summary).toContain("Hello");
});

test("degraded fallback uses the REAL text sender's own segment break — no dup, no loss", async () => {
  // CardKit content fails -> fall back to a real LarkSender; a tool boundary must split the text too.
  const cr = cardRecorder({ contentImpl: () => ({ ok: false, code: 99 }) });
  const creates: string[] = [];
  const updates: { messageId: string; text: string }[] = [];
  let n = 0;
  let t = 1_000_000;
  const lark = new LarkSender({
    chatId: "oc_1",
    send: async (req: SendRequest): Promise<SendResult> => { creates.push(req.text); return { ok: true, code: 0, messageId: `t${++n}` }; },
    update: async (req: UpdateRequest): Promise<SendResult> => { updates.push({ messageId: req.messageId, text: req.text }); return { ok: true, code: 0, messageId: req.messageId }; },
    streamMinEditIntervalMs: 0,
    minIntervalMs: 0,
    now: () => t,
    wait: async (ms: number) => { t += ms; },
  });
  const s = new CardSender({
    chatId: "oc_1", create: cr.create, send: cr.send, content: cr.content, finalize: cr.finalize,
    fallback: lark, enableToolHint: false, minEditIntervalMs: 250, now: cr.now, wait: cr.wait,
  });
  s.streamUpdate("Hello"); await s.whenIdle();           // card1 "Hello" on the card side
  s.streamUpdate("Hello world"); await s.whenIdle();     // content edit fails -> fall back from offset 5
  expect(creates).toEqual([" world"]);                   // text sender shows only the unshown remainder
  s.streamSegmentBreak(); await s.whenIdle();            // tool boundary -> text sender soft-commits
  s.streamUpdate("Hello worldmore"); await s.whenIdle(); // remainder " worldmore"; text seg = "more"
  s.streamCommit(); await s.whenIdle();
  expect(creates).toEqual([" world", "more"]); // two text messages, no dup of "Hello"/" world", no loss
  expect(updates).toEqual([]);
});

// ── SDK adapter payloads (fake client) ──────────────────────────────────────────

test("sdkCardCreate sends a card_json payload carrying the streaming config", async () => {
  const captured: any[] = [];
  const client = { cardkit: { v1: { card: { create: async (p: any) => { captured.push(p); return { code: 0, data: { card_id: "cid" } }; } } } } } as any;
  const res = await sdkCardCreate(client)({ elementId: "md", text: "hi" });
  expect(res.ok).toBe(true);
  expect(res.cardId).toBe("cid");
  expect(captured[0].data.type).toBe("card_json");
  const card = JSON.parse(captured[0].data.data);
  expect(card.config.update_multi).toBe(true);
  expect(card.config.streaming_config).toBeDefined();
});

test("sdkCardContent puts content, sequence and uuid in the request data", async () => {
  const captured: any[] = [];
  const client = { cardkit: { v1: { cardElement: { content: async (p: any) => { captured.push(p); return { code: 0 }; } } } } } as any;
  const res = await sdkCardContent(client)({ cardId: "c1", elementId: "md", content: "hi", sequence: 3, uuid: "u-3" });
  expect(res.ok).toBe(true);
  expect(captured[0].path).toEqual({ card_id: "c1", element_id: "md" });
  expect(captured[0].data).toMatchObject({ content: "hi", sequence: 3, uuid: "u-3" });
});

test("sdkCardFinalize turns streaming off and carries summary + uuid", async () => {
  const captured: any[] = [];
  const client = { cardkit: { v1: { card: { settings: async (p: any) => { captured.push(p); return { code: 0 }; } } } } } as any;
  const res = await sdkCardFinalize(client)({ cardId: "c1", sequence: 5, uuid: "u-5", summary: "the answer" });
  expect(res.ok).toBe(true);
  expect(captured[0].data.uuid).toBe("u-5");
  expect(captured[0].data.sequence).toBe(5);
  const settings = JSON.parse(captured[0].data.settings);
  expect(settings.config.streaming_mode).toBe(false);
  expect(settings.config.summary.content).toBe("the answer");
});

// ── planSizeSplit (structure-aware, byte-budgeted) ──────────────────────────────

test("planSizeSplit returns null when the body fits the byte budget", () => {
  expect(planSizeSplit("hello world", 100)).toBeNull();
});

test("planSizeSplit prefers a blank-line (paragraph) boundary", () => {
  const body = "aaaa\n\nbbbb\n\ncccc";
  const r = planSizeSplit(body, 10)!;
  expect(r).not.toBeNull();
  expect(body.startsWith(r.headText)).toBe(true);
  expect(r.headText).toBe("aaaa\n\n");
  expect(r.closeFence).toBe("");
  expect(r.continuation).toBeUndefined();
});

test("planSizeSplit falls back to any line boundary when there is no blank line", () => {
  const r = planSizeSplit("aaaa\nbbbb\ncccc", 10)!;
  expect(r.headText).toBe("aaaa\nbbbb\n");
  expect(r.closeFence).toBe("");
});

test("planSizeSplit closes and reopens a code fence when forced to split inside it", () => {
  const r = planSizeSplit("```js\nAAAA\nBBBB\nCCCC\n```", 14)!;
  expect(r.headText).toBe("```js\nAAAA\n");
  expect(r.closeFence).toBe("```");
  expect(r.continuation?.openFence).toBe("```js");
  expect(r.continuation?.displayPrefix).toBe("```js\n");
});

test("planSizeSplit splits BEFORE a code fence when a safe boundary precedes it", () => {
  const r = planSizeSplit("intro text\n\n```js\nAAAA\nBBBB\nCCCC\n```", 14)!;
  expect(r.headText).toBe("intro text\n\n");
  expect(r.continuation).toBeUndefined(); // the whole fence rolls to the next card intact
});

test("planSizeSplit resends the table header when forced to split inside a table", () => {
  const body = "| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |\n| e | f |";
  const r = planSizeSplit(body, 45)!;
  expect(r.continuation?.tableHeader).toBe("| H1 | H2 |\n| --- | --- |");
  expect(r.continuation?.displayPrefix).toBe("| H1 | H2 |\n| --- | --- |\n");
  expect(r.closeFence).toBe("");
});

/** Contract every split result must satisfy: head is a true prefix; the displayed head (inherited
 *  prefix + head + close fence) fits the budget; and a non-empty tail remains. */
function assertSplitValid(body: string, budget: number, start: { displayPrefix?: string; openFence?: string; tableHeader?: string } | undefined, r: NonNullable<ReturnType<typeof planSizeSplit>>) {
  const prefix = start?.displayPrefix ?? (start?.openFence ? `${start.openFence}\n` : start?.tableHeader ? `${start.tableHeader}\n` : "");
  expect(body.startsWith(r.headText)).toBe(true); // true prefix, no fabricated chars/newlines
  expect(byteLen(prefix) + byteLen(r.headText) + byteLen(r.closeFence)).toBeLessThanOrEqual(budget);
  expect(r.headText.length).toBeGreaterThan(0);
  expect(body.slice(r.headText.length).length).toBeGreaterThan(0); // tail remains
}

test("planSizeSplit carries an inherited open fence and budgets its reopened prefix", () => {
  const start = { openFence: "```py", displayPrefix: "```py\n" };
  const r = planSizeSplit("MORE1\nMORE2\nMORE3", 20, start)!;
  expect(r.headText).toBe("MORE1\n");
  expect(r.closeFence).toBe("```");
  expect(r.continuation?.openFence).toBe("```py");
  assertSplitValid("MORE1\nMORE2\nMORE3", 20, start, r); // prefix + head + close <= budget
});

test("planSizeSplit preserves a ~~~ fence marker when closing/reopening", () => {
  const r = planSizeSplit("~~~js\nAAAA\nBBBB\nCCCC\n~~~", 14)!;
  expect(r.headText).toBe("~~~js\nAAAA\n");
  expect(r.closeFence).toBe("~~~"); // same marker, not backticks
  expect(r.continuation?.openFence).toBe("~~~js");
});

test("planSizeSplit splits a single over-budget line UTF-8-safely at a code-point boundary", () => {
  const body = "中".repeat(20); // 60 bytes, no newline
  const r = planSizeSplit(body, 14)!;
  expect(r.headText).toBe("中中中中"); // 12 bytes <= 14, never 13 (would split a char)
  expect(byteLen(r.headText)).toBe(12);
  assertSplitValid(body, 14, undefined, r);
});

test("planSizeSplit single-line fallback never splits an emoji surrogate pair", () => {
  const body = "🔧".repeat(10); // 40 bytes, 4 bytes each
  const r = planSizeSplit(body, 14)!;
  expect(r.headText).toBe("🔧🔧🔧"); // 12 bytes; the 4th would be 16 > 14
  expect([...r.headText].length).toBe(3); // whole code points
  assertSplitValid(body, 14, undefined, r);
});

test("planSizeSplit single over-budget line inside an inherited fence still closes/reopens", () => {
  const body = "x".repeat(40); // one long code line, no newline
  const start = { openFence: "```py", displayPrefix: "```py\n" };
  const r = planSizeSplit(body, 20, start)!;
  expect(r.closeFence).toBe("```");
  expect(r.continuation?.openFence).toBe("```py");
  assertSplitValid(body, 20, start, r);
});

test("planSizeSplit budgets by UTF-8 bytes, not JS length (CJK/emoji)", () => {
  expect(byteLen("中")).toBe(3);
  expect(byteLen("🔧")).toBe(4);
  const body = "中文测试\n\n日本語テスト";
  const r = planSizeSplit(body, 14)!;
  expect(r.headText).toBe("中文测试\n\n"); // 12 + 2 newline bytes = 14, fits; CJK not split
  expect(byteLen(r.headText)).toBe(14);
});

// ── size rollover (CardSender integration) ──────────────────────────────────────

test("size rollover: long markdown rolls into multiple cards with no loss", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 10 });
  s.streamUpdate("aaaa\n\nbbbb\n\ncccc");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["aaaa\n\n", "bbbb\n\ncccc"]);
  expect(r.creates.map((c) => c.text).join("")).toBe("aaaa\n\nbbbb\n\ncccc"); // no dup, no loss
  expect(r.finalizes).toHaveLength(2);
});

test("size rollover: a code fence crossing cards closes and reopens", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 14 });
  s.streamUpdate("```js\nAAAA\nBBBB\nCCCC\n```");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["```js\nAAAA\n```", "```js\nBBBB\n```", "```js\nCCCC\n```"]);
  for (const c of r.creates) expect((c.text.match(/```/g) ?? []).length % 2).toBe(0); // each card balanced
});

test("size rollover: a table crossing cards resends the header + separator", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 45 });
  s.streamUpdate("| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |\n| e | f |");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates).toHaveLength(2);
  expect(r.creates[1].text.startsWith("| H1 | H2 |\n| --- | --- |\n")).toBe(true); // header resent
  expect(r.creates[1].text).toContain("| c | d |"); // continued rows
  expect(r.creates[0].text).not.toContain("| c | d |"); // not duplicated on the first card
});

test("size rollover composes with a tool-call segment break (orthogonal), sequence monotonic", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 10 });
  s.streamUpdate("aaaaaaaa");
  await s.whenIdle();
  s.streamSegmentBreak({ toolName: "x" }); // seals card 1 at the tool boundary
  await s.whenIdle();
  s.streamUpdate("aaaaaaaabbbb\n\nccccdddd"); // post-tool text rolls by size
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["aaaaaaaa", "bbbb\n\n", "ccccdddd"]);
  expect(r.creates.map((c) => c.text).join("")).toBe("aaaaaaaabbbb\n\nccccdddd"); // no loss
  const sorted = [...r.seqLog].sort((a, b) => a - b);
  expect(r.seqLog).toEqual(sorted);
  expect(new Set(r.seqLog).size).toBe(r.seqLog.length);
});

test("size rollover budgets by UTF-8 bytes (CJK/emoji), never splitting a character", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 14 });
  const input = "中文测试\n\n日本語テスト";
  s.streamUpdate(input);
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.length).toBeGreaterThan(1);
  expect(r.creates.map((c) => c.text).join("")).toBe(input); // no loss, no broken chars
  for (const c of r.creates) expect(byteLen(c.text)).toBeLessThanOrEqual(14);
});

test("size rollover never shrinks the visible card backward (monotonic display)", async () => {
  // card fills to exactly budget, then more text arrives whose optimal split head is shorter than
  // what's already shown — the first card must NOT be rewritten to shorter text.
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 9 });
  s.streamUpdate("aaaa\nbbbb"); // 9 bytes == budget, shown whole
  await s.whenIdle();
  s.streamUpdate("aaaa\nbbbb\ncccc"); // optimal split head ("aaaa\n") is shorter than shown text
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates[0].text).toBe("aaaa\nbbbb"); // first card kept its full shown text
  // no content edit ever rewrote the first card to shorter text
  expect(r.contents.filter((c) => c.cardId === "card1" && c.content.length < "aaaa\nbbbb".length)).toHaveLength(0);
  expect(r.creates.map((c) => c.text).join("")).toBe("aaaa\nbbbb\ncccc"); // no loss, no dup
});

test("default tool hint + size rollover: first post-tool card shows the hint, content preserved", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { minEditIntervalMs: 0, maxCardBytes: 40 }); // hints default on
  const full = "introaaaa\n\nbbbbbbbbcc";
  s.streamUpdate("intro");
  await s.whenIdle();
  s.streamSegmentBreak({ toolName: "bash" }); // seals card 1, arms the hint for the next card
  await s.whenIdle();
  s.streamUpdate(full); // post-tool text large enough to roll by size
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  const hint = "🔧 调用工具：bash\n\n";
  expect(r.creates[0].text).toBe("intro");
  expect(r.creates[1].text.startsWith(hint)).toBe(true); // hint is the first line of the first post-tool card
  // strip the cosmetic hint; the real turn text is preserved across cards with no loss
  const reconstructed = r.creates.map((c) => c.text.replace(hint, "")).join("");
  expect(reconstructed).toBe(full);
  const sorted = [...r.seqLog].sort((a, b) => a - b);
  expect(r.seqLog).toEqual(sorted);
  expect(new Set(r.seqLog).size).toBe(r.seqLog.length);
});

test("size rollover keeps sequence strictly increasing across content edits and rollovers", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 10 });
  s.streamUpdate("aa\nbb");
  await s.whenIdle();
  s.streamUpdate("aa\nbb\nccc");
  await s.whenIdle();
  s.streamUpdate("aa\nbb\nccc\nddddddd");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.seqLog.length).toBeGreaterThanOrEqual(3);
  const sorted = [...r.seqLog].sort((a, b) => a - b);
  expect(r.seqLog).toEqual(sorted);
  expect(new Set(r.seqLog).size).toBe(r.seqLog.length);
});

test("size rollover gives each card send a unique uuid even for identical display text", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 6 });
  s.streamUpdate("AAAA\n\nAAAA\n\nAAAA");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates[0].text).toBe(r.creates[1].text); // first two cards display identical text
  const uuids = r.sends.map((x) => x.uuid);
  expect(new Set(uuids).size).toBe(uuids.length); // ...but each send uuid is unique (no Feishu dedupe)
});

test("size rollover closes a long single-line code block on its own line (not glued)", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 14 });
  s.streamUpdate("```py\n" + "x".repeat(20)); // a single code line longer than the budget
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  for (const c of r.creates) expect(/[^\n`]```$/.test(c.text)).toBe(false); // never "...code```"
  expect(r.creates.some((c) => c.text.startsWith("```py") && c.text.endsWith("\n```"))).toBe(true);
});

// ── streaming-window timeout rollover ───────────────────────────────────────────

test("timeout rollover: a long-running turn rolls onto a fresh card after the window", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardAgeMs: 1000 });
  s.streamUpdate("hello");
  await s.whenIdle();
  r.advance(1500); // exceed the streaming window
  s.streamUpdate("hello world");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["hello", " world"]);
  expect(r.creates.map((c) => c.text).join("")).toBe("hello world"); // no loss, no dup
  expect(r.finalizes).toHaveLength(2);
});

/** Final displayed content of a card: its last content edit, else its create text. */
function finalContent(r: ReturnType<typeof cardRecorder>, cardId: string): string {
  const edits = r.contents.filter((c) => c.cardId === cardId);
  if (edits.length) return edits[edits.length - 1].content;
  const create = r.creates.findIndex((_c, i) => `card${i + 1}` === cardId);
  return create >= 0 ? r.creates[create].text : "";
}

test("timeout rollover inside a code fence closes the current card and reopens on the next", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardAgeMs: 1000 });
  s.streamUpdate("```js\ncode1");
  await s.whenIdle();
  r.advance(1500);
  s.streamUpdate("```js\ncode1\ncode2");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(finalContent(r, "card1")).toBe("```js\ncode1\n```"); // sealed card balanced (close appended)
  expect((finalContent(r, "card1").match(/```/g) ?? []).length % 2).toBe(0);
  expect(r.creates[1].text.startsWith("```js")).toBe(true); // fence reopened on the continued card
  // (card2 mirrors the input's own unclosed trailing fence; the renderer auto-closes at card end)
  // strip the display-only repair (appended close + reopened fence) — body reconstructs with no loss
  const body1 = finalContent(r, "card1").replace(/\n```$/, ""); // "```js\ncode1"
  const body2 = finalContent(r, "card2").replace(/^```js\n/, ""); // "\ncode2"
  expect(body1 + body2).toBe("```js\ncode1\ncode2");
});

test("shrink-guard rollover inside a code fence also closes the current card and reopens", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardBytes: 14 });
  s.streamUpdate("```js\nAAAA"); // 10B, fits
  await s.whenIdle();
  s.streamUpdate("```js\nAAAA\nBB"); // 13B, fits (content edit)
  await s.whenIdle();
  s.streamUpdate("```js\nAAAA\nBB\nCC"); // optimal split head shorter than shown -> shrink guard
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(finalContent(r, "card1")).toBe("```js\nAAAA\nBB\n```"); // sealed card balanced, not shrunk
  expect((finalContent(r, "card1").match(/```/g) ?? []).length % 2).toBe(0);
  expect(r.creates[1].text.startsWith("```js")).toBe(true); // reopened on the continued card
});

test("timeout rollover with a pending tool hint does not lose or duplicate the hint/body", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { minEditIntervalMs: 0, maxCardAgeMs: 1000 }); // hints on
  s.streamUpdate("intro");
  await s.whenIdle();
  s.streamSegmentBreak({ toolName: "bash" }); // arms the hint for the next card
  await s.whenIdle();
  s.streamUpdate("introAAAA"); // first post-tool card carries the hint
  await s.whenIdle();
  r.advance(1500); // that hint card ages out
  s.streamUpdate("introAAAABBBB");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  const hint = "🔧 调用工具：bash\n\n";
  expect(r.creates[1].text.startsWith(hint)).toBe(true); // hint shown once, on the first post-tool card
  expect(r.creates.slice(2).some((c) => c.text.includes("🔧"))).toBe(false); // never duplicated after rollover
  const reconstructed = r.creates.map((c) => c.text.replace(hint, "")).join("");
  expect(reconstructed).toBe("introAAAABBBB"); // body preserved across the timeout boundary
});

test("timeout rollover keeps sequence strictly increasing", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { enableToolHint: false, minEditIntervalMs: 0, maxCardAgeMs: 1000 });
  s.streamUpdate("aa");
  await s.whenIdle();
  s.streamUpdate("aabb"); // content edit
  await s.whenIdle();
  r.advance(1500);
  s.streamUpdate("aabbcc"); // ages out -> timeout rollover
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  const sorted = [...r.seqLog].sort((a, b) => a - b);
  expect(r.seqLog).toEqual(sorted);
  expect(new Set(r.seqLog).size).toBe(r.seqLog.length);
});

// ── lifecycle ────────────────────────────────────────────────────────────────────

test("stop() halts the card sender and the fallback and blocks further work", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.stop();
  expect(fb.stopped).toBe(1);
  s.streamUpdate("ignored");
  s.enqueue("ignored");
  await s.whenIdle();
  expect(r.creates).toHaveLength(0);
  expect(fb.enqueued).toHaveLength(0);
});

// ── C2: artifact images as card boundaries (Opt-2) ──────────────────────────────

test("an artifact image splits a turn into prose card → image placeholder card → prose card", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("prose ![a](artifact:a.png) more\n");
  s.streamCommit();
  await s.whenIdle();
  // three cards in order: the prose before, the image placeholder, the prose after (token NOT shown)
  expect(r.creates.map((c) => c.text)).toEqual(["prose ", "🖼 a", " more\n"]);
  expect(r.sends).toHaveLength(3);
  expect(r.finalizes.map((f) => f.cardId)).toEqual(["card1", "card2", "card3"]); // prose sealed before image card
  expect(fb.streamUpdates).toHaveLength(0); // no fallback
});

test("the image placeholder card never carries the raw artifact token; prose cards never show it", async () => {
  const r = cardRecorder();
  const s = makeSender(r, fakeFallback());
  s.streamUpdate("![d](artifact://codex-1/out.png)\n");
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["🖼 d"]); // only the placeholder card, no prose card
  const blob = r.creates.map((c) => c.text).join("|");
  expect(blob).not.toContain("artifact:");
  expect(blob).not.toContain("artifact://");
});

test("a GFM table turn stays one markdown card — no image card, no table component", async () => {
  const r = cardRecorder();
  const s = makeSender(r, fakeFallback());
  const table = "| mod | st |\n| --- | --- |\n| a | ok |\n";
  s.streamUpdate(table);
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual([table]); // whole table in one markdown card
  expect(r.creates.some((c) => c.text.startsWith("🖼"))).toBe(false);
});

test("an artifact token inside a fenced code block does NOT create an image card", async () => {
  const r = cardRecorder();
  const s = makeSender(r, fakeFallback());
  const code = "```\n![x](artifact:x.png)\n```\n";
  s.streamUpdate(code);
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual([code]); // the token stays literal in the code card
  expect(r.creates.some((c) => c.text.startsWith("🖼"))).toBe(false);
});

test("multiple images produce ordered prose/image/prose/image/prose cards", async () => {
  const r = cardRecorder();
  const s = makeSender(r, fakeFallback());
  s.streamUpdate("a ![x](artifact:x.png) b ![y](artifact:y.png) c\n");
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["a ", "🖼 x", " b ", "🖼 y", " c\n"]);
});

test("prose-only turns are unchanged: no extra cards, single create + content edits as before", async () => {
  const r = cardRecorder();
  const s = makeSender(r, fakeFallback());
  s.streamUpdate("Hello");
  await s.whenIdle();
  s.streamUpdate("Hello world");
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["Hello"]); // exactly one card
  expect(r.contents.map((c) => c.content)).toEqual(["Hello world"]);
  expect(r.finalizes).toHaveLength(1);
});

test("a failed image placeholder card degrades to text from the image (incl. the literal markdown)", async () => {
  const r = cardRecorder({ createImpl: (req, n) => (req.text.startsWith("🖼") ? { ok: false, code: 1 } : { ok: true, cardId: `card${n}` }) });
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("prose ![a](artifact:a.png) tail\n");
  s.streamCommit();
  await s.whenIdle();
  // the prose-before card was sent; the image card failed → fallback owns the remainder from the image
  expect(r.creates.map((c) => c.text)).toEqual(["prose ", "🖼 a"]);
  expect(fb.streamUpdates.length).toBeGreaterThan(0);
  expect(fb.streamUpdates.at(-1)).toBe("![a](artifact:a.png) tail\n"); // literal markdown preserved, nothing lost
  expect(fb.commits).toBe(1);
});

test("a trailing image with no newline is flushed at commit (final)", async () => {
  const r = cardRecorder();
  const s = makeSender(r, fakeFallback());
  s.streamUpdate("see "); // partial line, no image yet
  await s.whenIdle();
  s.streamUpdate("see ![a](artifact:a.png)"); // image now complete but no trailing newline
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["see ", "🖼 a"]); // prose card then image card at commit
});

// ── C3: artifact image upload → swap the placeholder card's element (non-blocking) ──────────────

import type { CardElementUpdateRequest } from "./card-sender";
import type { ResolvedImage } from "./card-image";

function makeImageSender(
  r: ReturnType<typeof cardRecorder>,
  fb: ReturnType<typeof fakeFallback>,
  resolve: (b: { ref: string; alt: string }) => Promise<ResolvedImage>,
) {
  const updates: CardElementUpdateRequest[] = [];
  const sender = new CardSender({
    chatId: "oc_1",
    create: r.create,
    send: r.send,
    content: r.content,
    finalize: r.finalize,
    fallback: fb.sink,
    now: r.now,
    wait: r.wait,
    resolveImage: { resolve: resolve as any },
    updateElement: async (req) => {
      updates.push(req);
      return { ok: true };
    },
  });
  return { sender, updates };
}

const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

test("a successful upload swaps the placeholder element for an img element with the image_key", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const { sender, updates } = makeImageSender(r, fb, async () => ({ kind: "image", imgKey: "img_xyz" }));
  sender.streamUpdate("p ![a](artifact:a.png) q\n");
  sender.streamCommit();
  await sender.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["p ", "🖼 a", " q\n"]); // prose, placeholder, prose
  expect(updates).toHaveLength(1);
  const el = JSON.parse(updates[0].element);
  expect(el).toMatchObject({ tag: "img", img_key: "img_xyz" });
  expect(updates[0].element).not.toContain("artifact:"); // no raw ref leaks into the card
});

test("an over-limit / failed upload degrades that image card to a link/text element; prose continues", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const { sender, updates } = makeImageSender(r, fb, async () => ({ kind: "link", markdown: "[diagram](https://console/x)" }));
  sender.streamUpdate("before ![d](artifact:d.png) after\n");
  sender.streamCommit();
  await sender.whenIdle();
  // prose cards intact (turn NOT fully fallen back), placeholder swapped to a markdown link element
  expect(r.creates.map((c) => c.text)).toEqual(["before ", "🖼 d", " after\n"]);
  expect(fb.streamUpdates).toHaveLength(0); // not a whole-turn text fallback
  const el = JSON.parse(updates[0].element);
  expect(el).toMatchObject({ tag: "markdown", content: "[diagram](https://console/x)" });
});

test("the upload is non-blocking: prose after the image is sent BEFORE the upload resolves", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  let release!: (v: ResolvedImage) => void;
  const gate = new Promise<ResolvedImage>((res) => (release = res));
  const { sender, updates } = makeImageSender(r, fb, () => gate);
  sender.streamUpdate("p ![a](artifact:a.png) q\n");
  await tick(); // driver runs to completion; the image task is parked on `gate`
  expect(r.creates.map((c) => c.text)).toEqual(["p ", "🖼 a", " q\n"]); // prose-after already sent
  expect(updates).toHaveLength(0); // upload not resolved → element not swapped yet (non-blocking)
  release({ kind: "image", imgKey: "img_1" });
  sender.streamCommit();
  await sender.whenIdle(); // the commit barrier drains the pending image task
  expect(updates).toHaveLength(1);
});

test("whenIdle waits for in-flight image tasks (commit barrier never releases mid-upload)", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  let resolved = false;
  const { sender, updates } = makeImageSender(r, fb, async () => {
    await new Promise((res) => setTimeout(res, 0));
    resolved = true;
    return { kind: "image", imgKey: "k" };
  });
  sender.streamUpdate("![a](artifact:a.png)\n");
  sender.streamCommit();
  await sender.whenIdle();
  expect(resolved).toBe(true);
  expect(updates).toHaveLength(1);
});

// ── C4: non-streaming one-shot rich render (sendOneShot) ────────────────────────

test("sendOneShot renders a prose-only reply as a single finalized markdown card", async () => {
  const r = cardRecorder();
  const s = makeSender(r, fakeFallback());
  s.sendOneShot("hello\nworld\n");
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["hello\nworld\n"]);
  expect(r.finalizes).toHaveLength(1);
});

test("sendOneShot renders prose + artifact image as ordered prose/image/prose cards", async () => {
  const r = cardRecorder();
  const s = makeSender(r, fakeFallback());
  s.sendOneShot("see ![a](artifact:a.png) done\n");
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["see ", "🖼 a", " done\n"]);
});

test("sendOneShot keeps a code-guarded token literal (no image card)", async () => {
  const r = cardRecorder();
  const s = makeSender(r, fakeFallback());
  const code = "```\n![x](artifact:x.png)\n```\n";
  s.sendOneShot(code);
  await s.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual([code]);
});

test("sendOneShot uploads + swaps the image element (C3 path) in non-streaming mode", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const { sender, updates } = makeImageSender(r, fb, async () => ({ kind: "image", imgKey: "img_one" }));
  sender.sendOneShot("p ![a](artifact:a.png) q\n");
  await sender.whenIdle();
  expect(r.creates.map((c) => c.text)).toEqual(["p ", "🖼 a", " q\n"]);
  expect(JSON.parse(updates[0].element)).toMatchObject({ tag: "img", img_key: "img_one" });
});

// ── C4 follow-up: NO raw SDK message / Error / ref / image_key in any CardKit log ───────────────

const SECRET_MSG = "artifact://owner/SECRET.png image_key=KK99 leaked";
const assertClean = (logs: string[]) => {
  const blob = logs.join("\n");
  expect(blob).not.toContain("SECRET");
  expect(blob).not.toContain("artifact:");
  expect(blob).not.toContain("image_key");
  expect(blob).not.toContain("KK99");
};

test("create failure: the secret-laden SDK message is NOT logged (code only)", async () => {
  const logs: string[] = [];
  const r = cardRecorder({ createImpl: () => ({ ok: false, code: 1, message: SECRET_MSG }) });
  const s = makeSender(r, fakeFallback(), { log: (m) => logs.push(m) });
  s.streamUpdate("hello");
  s.streamCommit();
  await s.whenIdle();
  assertClean(logs);
  expect(logs.join("\n")).toContain("(code 1)"); // numeric code is allowed
});

test("a thrown SDK Error during create/send is logged generically (message dropped)", async () => {
  const logs: string[] = [];
  const r = cardRecorder({ createImpl: () => { throw new Error(`boom ${SECRET_MSG}`); } });
  const s = makeSender(r, fakeFallback(), { log: (m) => logs.push(m) });
  s.streamUpdate("hi");
  s.streamCommit();
  await s.whenIdle();
  assertClean(logs);
  expect(logs.join("\n")).toContain("create/send error");
});

test("content + finalize failures never log the SDK message", async () => {
  const logs: string[] = [];
  const r = cardRecorder({
    contentImpl: () => ({ ok: false, code: 2, message: SECRET_MSG }),
    finalizeImpl: () => ({ ok: false, code: 3, message: SECRET_MSG }),
  });
  const s = makeSender(r, fakeFallback(), { log: (m) => logs.push(m) });
  s.streamUpdate("a");
  await s.whenIdle();
  s.streamUpdate("ab"); // forces a content edit (which fails with the secret message)
  s.streamCommit();
  await s.whenIdle();
  assertClean(logs);
});

test("image element update failure logs code only, never the SDK message", async () => {
  const logs: string[] = [];
  const r = cardRecorder();
  const sender = new CardSender({
    chatId: "oc_1",
    create: r.create,
    send: r.send,
    content: r.content,
    finalize: r.finalize,
    fallback: fakeFallback().sink,
    now: r.now,
    wait: r.wait,
    log: (m) => logs.push(m),
    resolveImage: { resolve: async () => ({ kind: "image", imgKey: "img_1" }) },
    updateElement: async () => ({ ok: false, code: 7, message: SECRET_MSG }),
  });
  sender.sendOneShot("p ![a](artifact:a.png) q\n");
  await sender.whenIdle();
  assertClean(logs);
});

// ── P1 regression: a bracketed-alt artifact image never leaks its raw ref through the streaming path ──

test("STREAMING: a bracketed-alt artifact image is extracted; no op ever carries the raw artifact ref", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const { sender, updates } = makeImageSender(r, fb, async () => ({ kind: "text", markdown: "🖼 (image too wide)" })); // simulate dims-degrade
  const full = "Comparison board:\n\n![accents [before vs after]](artifact://team1_builder/ui-p1-accents-compare.png)\n\nNotes follow.\n";
  for (let i = 8; i < full.length; i += 19) { // feed incrementally (streaming, token split across ticks)
    sender.streamUpdate(full.slice(0, i));
    await sender.whenIdle();
  }
  sender.streamUpdate(full);
  sender.streamCommit();
  await sender.whenIdle();
  const allOps = [...r.creates.map((c) => c.text), ...r.contents.map((c) => c.content), ...updates.map((u) => u.element)].join("|");
  expect(allOps).not.toContain("artifact:"); // the raw ref never reaches a create/content/update op
  expect(r.creates.some((c) => c.text.startsWith("🖼"))).toBe(true); // an image card was emitted for it
});

// ── tool annotation (de-noising) — structure / budget / rollover interaction ─────

test("tool annotation renders OUTSIDE an open code fence, behind a divider (no new message)", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("intro\n```js\nconst a = 1"); // body ends INSIDE an open code fence
  await s.whenIdle();
  s.streamToolAnnotation("🔧 调用了 1 个工具");
  await s.whenIdle();
  expect(r.creates).toHaveLength(1); // in-place edit, NOT a new message/card
  const last = r.contents.at(-1)!.content;
  // the fence is closed (display-only) before the divider+annotation; annotation is not inside the block
  expect(last).toContain("const a = 1\n```\n\n---\n\n🔧 调用了 1 个工具");
  expect(last.endsWith("🔧 调用了 1 个工具")).toBe(true);
  expect(fb.enqueued).toEqual([]); // never fell back
});

test("tool annotation: a same-body count change still drives an in-place edit (no new card)", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb);
  s.streamUpdate("hello");
  await s.whenIdle();
  s.streamToolAnnotation("🔧 调用了 1 个工具");
  await s.whenIdle();
  s.streamToolAnnotation("🔧 调用了 2 个工具"); // same body, new count
  await s.whenIdle();
  expect(r.creates).toHaveLength(1); // still ONE message
  expect(r.contents.at(-1)!.content).toContain("🔧 调用了 2 个工具"); // updated in place
});

test("tool annotation is reserved in the size budget — no over-budget card, no fallback", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const annotation = "🔧 调用了 1 个工具";
  // body fits the budget ALONE, but body + annotation suffix would exceed it ⇒ a split is forced and
  // the annotation rides the tail; without the suffix reservation this would over-budget or fall back.
  const body = "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\ndddddddddd\nend";
  const maxCardBytes = byteLen(body); // exactly fits body alone
  const s = makeSender(r, fb, { maxCardBytes });
  s.streamUpdate(body);
  s.streamToolAnnotation(annotation);
  s.streamCommit();
  await s.whenIdle();
  expect(fb.enqueued).toEqual([]); // CardKit never gave up
  const displays = [...r.creates.map((c) => c.text), ...r.contents.map((c) => c.content)];
  for (const d of displays) expect(byteLen(d)).toBeLessThanOrEqual(maxCardBytes); // every card within budget
  expect(displays.join("\n")).toContain(annotation); // annotation still delivered (on the final card)
});

test("tool annotation: planSizeSplit reserves suffixBytes (splits a body that fits alone)", () => {
  const body = "alpha\nbravo\ncharlie"; // 19 bytes, 3 lines
  expect(planSizeSplit(body, byteLen(body))).toBeNull(); // fits alone → no split
  // with a reserved suffix it no longer fits → a split is returned, head is a true prefix of body
  const split = planSizeSplit(body, byteLen(body), { suffixBytes: 8 });
  expect(split).not.toBeNull();
  expect(body.startsWith(split!.headText)).toBe(true);
  expect(split!.headText.length).toBeLessThan(body.length); // leaves a tail for the annotation card
});

test("tool annotation survives a timeout rollover (kept, not lost; tail continues)", async () => {
  const r = cardRecorder();
  const fb = fakeFallback();
  const s = makeSender(r, fb, { maxCardAgeMs: 1000 });
  s.streamUpdate("first part");
  await s.whenIdle();
  s.streamToolAnnotation("🔧 调用了 1 个工具");
  await s.whenIdle();
  r.advance(2000); // age the live card past maxCardAgeMs
  s.streamUpdate("first part second part"); // forces a timeout rollover before editing the aged card
  await s.whenIdle();
  s.streamCommit();
  await s.whenIdle();
  expect(fb.enqueued).toEqual([]); // no fallback
  const displays = [...r.creates.map((c) => c.text), ...r.contents.map((c) => c.content)];
  expect(displays.join("\n")).toContain("🔧 调用了 1 个工具"); // annotation preserved across the rollover
  expect(displays.join("")).toContain("second part"); // tail body not lost
});
