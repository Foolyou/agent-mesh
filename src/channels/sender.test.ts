import { test, expect } from "bun:test";
import { LarkSender, defaultIdempotencyKey, safeUuid, type SendRequest, type SendResult } from "./sender";

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
