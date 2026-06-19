import { test, expect } from "bun:test";
import {
  CardSender,
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
    return opts?.contentImpl ? opts.contentImpl(req, ++conN) : { ok: true };
  };
  const finalize = async (req: CardFinalizeRequest): Promise<CardFinalizeResult> => {
    finalizes.push(req);
    return opts?.finalizeImpl ? opts.finalizeImpl(req, ++finN) : { ok: true };
  };
  const now = () => t;
  const wait = async (ms: number) => {
    t += ms;
  };
  return { creates, sends, contents, finalizes, create, send, content, finalize, now, wait };
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

function makeSender(r: ReturnType<typeof cardRecorder>, fb: ReturnType<typeof fakeFallback>, extra?: Partial<{ log: (m: string) => void; minEditIntervalMs: number }>) {
  return new CardSender({
    chatId: "oc_1",
    create: r.create,
    send: r.send,
    content: r.content,
    finalize: r.finalize,
    fallback: fb.sink,
    minEditIntervalMs: extra?.minEditIntervalMs ?? 250,
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
