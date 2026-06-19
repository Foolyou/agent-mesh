import { test, expect } from "bun:test";
import { LarkSender, defaultIdempotencyKey, safeUuid, type SendRequest, type SendResult, type UpdateRequest } from "./sender";

/** Recorder with a virtual clock so edit throttling is deterministic. `wait(ms)` advances time. */
function streamRecorder(updateImpl?: (req: UpdateRequest, n: number) => SendResult) {
  const creates: string[] = [];
  const updates: { messageId: string; text: string }[] = [];
  let msgN = 0;
  let updN = 0;
  let t = 1_000_000;
  const send = async (req: SendRequest): Promise<SendResult> => {
    creates.push(req.text);
    return { ok: true, code: 0, messageId: `m${++msgN}` };
  };
  const update = async (req: UpdateRequest): Promise<SendResult> => {
    updates.push({ messageId: req.messageId, text: req.text });
    return updateImpl ? updateImpl(req, ++updN) : { ok: true, code: 0, messageId: req.messageId };
  };
  const now = () => t;
  const wait = async (ms: number) => { t += ms; };
  return { creates, updates, send, update, now, wait };
}

function recordingSend() {
  const calls: SendRequest[] = [];
  const send = async (req: SendRequest): Promise<SendResult> => {
    calls.push(req);
    return { ok: true, code: 0 };
  };
  return { send, calls };
}

test("enqueue sends through the SDK seam with chat id, text and uuid", async () => {
  const { send, calls } = recordingSend();
  const s = new LarkSender({ chatId: "oc_1", send });
  s.enqueue("hello world");
  await s.whenIdle();
  expect(calls).toHaveLength(1);
  expect(calls[0].chatId).toBe("oc_1");
  expect(calls[0].text).toBe("hello world");
  expect(calls[0].uuid).toBeTruthy();
});

test("blank / whitespace text is never sent", async () => {
  const { send, calls } = recordingSend();
  const s = new LarkSender({ chatId: "oc_1", send });
  s.enqueue("");
  s.enqueue("   \n  ");
  await s.whenIdle();
  expect(calls).toHaveLength(0);
});

test("serializes sends and applies the min interval between them", async () => {
  const { send, calls } = recordingSend();
  const waited: number[] = [];
  const wait = async (ms: number) => {
    waited.push(ms);
  };
  const s = new LarkSender({ chatId: "oc_1", send, minIntervalMs: 500, wait });
  s.enqueue("a");
  s.enqueue("b");
  s.enqueue("c");
  await s.whenIdle();
  expect(calls.map((c) => c.text)).toEqual(["a", "b", "c"]);
  expect(waited).toEqual([500, 500]);
});

test("a failing send is logged and does not stop the queue", async () => {
  const logs: string[] = [];
  let n = 0;
  const calls: string[] = [];
  const send = async (req: SendRequest): Promise<SendResult> => {
    calls.push(req.text);
    return ++n === 1 ? { ok: false, code: 3, message: "missing scope" } : { ok: true, code: 0 };
  };
  const s = new LarkSender({ chatId: "oc_1", send, log: (m) => logs.push(m) });
  s.enqueue("first");
  s.enqueue("second");
  await s.whenIdle();
  expect(calls).toEqual(["first", "second"]);
  expect(logs.some((l) => l.includes("code 3") && l.includes("missing scope"))).toBe(true);
});

test("default idempotency key is deterministic; explicit key overrides after uuid sanitization", async () => {
  expect(defaultIdempotencyKey("oc_1", "hi")).toBe(defaultIdempotencyKey("oc_1", "hi"));
  expect(defaultIdempotencyKey("oc_1", "hi")).not.toBe(defaultIdempotencyKey("oc_1", "bye"));
  expect(safeUuid("turn_7")).toBe("turn_7");
  expect(safeUuid("turn:7")).toMatch(/^mesh-/);
  const { send, calls } = recordingSend();
  const s = new LarkSender({ chatId: "oc_1", send });
  s.enqueue("hi", "turn-7-flush-2");
  await s.whenIdle();
  expect(calls[0].uuid).toBe("turn-7-flush-2");
});

test("stop() drops queued messages and blocks further enqueues", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slowSend = async (req: SendRequest): Promise<SendResult> => {
    calls.push(req.text);
    await gate;
    return { ok: true, code: 0 };
  };
  const s = new LarkSender({ chatId: "oc_1", send: slowSend });
  s.enqueue("a");
  s.enqueue("b");
  s.stop();
  s.enqueue("c");
  release();
  await s.whenIdle();
  expect(calls).toEqual(["a"]);
});

// ── true streaming (in-place edit) ─────────────────────────────────────────────

test("streaming: first chunk creates one message, later chunks edit it in place", async () => {
  const r = streamRecorder();
  const s = new LarkSender({ chatId: "oc_1", send: r.send, update: r.update, streamMinEditIntervalMs: 1000, now: r.now, wait: r.wait });
  s.streamUpdate("Hello");
  await s.whenIdle();
  expect(r.creates).toEqual(["Hello"]); // first send is immediate
  s.streamUpdate("Hello world");
  await s.whenIdle();
  expect(r.updates).toEqual([{ messageId: "m1", text: "Hello world" }]); // edited, not re-sent
  expect(r.creates).toEqual(["Hello"]);
});

test("streaming: rapid updates within the throttle window coalesce into one edit", async () => {
  const r = streamRecorder();
  const s = new LarkSender({ chatId: "oc_1", send: r.send, update: r.update, streamMinEditIntervalMs: 1000, now: r.now, wait: r.wait });
  s.streamUpdate("a");
  s.streamUpdate("ab");
  s.streamUpdate("abc");
  await s.whenIdle();
  expect(r.creates).toEqual(["a"]);
  expect(r.updates).toEqual([{ messageId: "m1", text: "abc" }]); // "ab" was coalesced away
});

test("streaming: rolls over to a fresh message at the edit cap with no duplicated text", async () => {
  const r = streamRecorder();
  const s = new LarkSender({ chatId: "oc_1", send: r.send, update: r.update, streamMinEditIntervalMs: 1000, maxEditsPerMessage: 2, now: r.now, wait: r.wait });
  s.streamUpdate("1"); await s.whenIdle();
  s.streamUpdate("12"); await s.whenIdle();
  s.streamUpdate("123"); await s.whenIdle();
  s.streamUpdate("1234"); await s.whenIdle();
  expect(r.creates).toEqual(["1", "4"]); // m1 sealed at "123", m2 carries only the remainder
  expect(r.updates).toEqual([{ messageId: "m1", text: "12" }, { messageId: "m1", text: "123" }]);
});

test("streaming: a 230072 edit-limit error rolls over to a new message", async () => {
  const r = streamRecorder((_req, n) => (n === 1 ? { ok: false, code: 230072 } : { ok: true }));
  const s = new LarkSender({ chatId: "oc_1", send: r.send, update: r.update, streamMinEditIntervalMs: 1000, now: r.now, wait: r.wait });
  s.streamUpdate("a"); await s.whenIdle();
  s.streamUpdate("ab"); await s.whenIdle();
  expect(r.creates).toEqual(["a", "b"]); // edit failed with 230072 -> m2 carries "b"
});

test("streaming: commit seals the live message so the next turn starts fresh", async () => {
  const r = streamRecorder();
  const s = new LarkSender({ chatId: "oc_1", send: r.send, update: r.update, streamMinEditIntervalMs: 1000, now: r.now, wait: r.wait });
  s.streamUpdate("x"); s.streamCommit(); await s.whenIdle();
  s.streamUpdate("y"); s.streamCommit(); await s.whenIdle();
  expect(r.creates).toEqual(["x", "y"]); // two separate turns, two messages
  expect(r.updates).toEqual([]);
});

test("streaming: without an update seam, commit delivers the whole turn as one ordinary send", async () => {
  const r = streamRecorder();
  const s = new LarkSender({ chatId: "oc_1", send: r.send, now: r.now, wait: r.wait }); // no update fn
  s.streamUpdate("partial");
  s.streamUpdate("partial final");
  s.streamCommit();
  await s.whenIdle();
  expect(r.creates).toEqual(["partial final"]);
  expect(r.updates).toEqual([]);
});

test("streaming: a segment break seals the live message and the next text opens a new one", async () => {
  const r = streamRecorder();
  const s = new LarkSender({ chatId: "oc_1", send: r.send, update: r.update, streamMinEditIntervalMs: 1000, now: r.now, wait: r.wait });
  s.streamUpdate("Before"); await s.whenIdle();
  s.streamSegmentBreak(); await s.whenIdle();
  s.streamUpdate("BeforeAfter"); await s.whenIdle(); // full turn text; only the tail is the new message
  s.streamCommit(); await s.whenIdle();
  expect(r.creates).toEqual(["Before", "After"]); // two messages, no duplicated prefix
  expect(r.updates).toEqual([]);
});

test("streaming: a segment break with nothing pending sends no empty message", async () => {
  const r = streamRecorder();
  const s = new LarkSender({ chatId: "oc_1", send: r.send, update: r.update, now: r.now, wait: r.wait });
  s.streamSegmentBreak(); await s.whenIdle();
  s.streamCommit(); await s.whenIdle();
  expect(r.creates).toEqual([]);
});

test("streaming without an update seam: a segment break flushes the segment as its own message", async () => {
  const { send, calls } = recordingSend();
  const s = new LarkSender({ chatId: "oc_1", send }); // no update fn
  s.streamUpdate("seg1");
  s.streamSegmentBreak();
  s.streamUpdate("seg1seg2");
  s.streamCommit();
  await s.whenIdle();
  expect(calls.map((c) => c.text)).toEqual(["seg1", "seg2"]); // each segment its own message, no dup
});
