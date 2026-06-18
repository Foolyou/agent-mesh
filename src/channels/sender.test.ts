import { test, expect } from "bun:test";
import { LarkSender, defaultIdempotencyKey, type SendResult } from "./sender";

function recordingSend() {
  const calls: string[][] = [];
  const send = async (args: string[]): Promise<SendResult> => {
    calls.push(args);
    return { code: 0 };
  };
  return { send, calls };
}

function argMap(args: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) if (args[i].startsWith("--")) m[args[i]] = args[i + 1];
  return m;
}

test("enqueue sends with chat-id, markdown body and an idempotency key", async () => {
  const { send, calls } = recordingSend();
  const s = new LarkSender({ chatId: "oc_1", send });
  s.enqueue("hello world");
  await s.whenIdle();
  expect(calls).toHaveLength(1);
  expect(calls[0].slice(0, 2)).toEqual(["im", "+messages-send"]);
  const m = argMap(calls[0]);
  expect(m["--chat-id"]).toBe("oc_1");
  expect(m["--markdown"]).toBe("hello world");
  expect(m["--idempotency-key"]).toBeTruthy();
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
  expect(calls.map((c) => argMap(c)["--markdown"])).toEqual(["a", "b", "c"]); // order preserved
  expect(waited).toEqual([500, 500]); // a gap before b and before c, none before a
});

test("a failing send is logged and does not stop the queue", async () => {
  const logs: string[] = [];
  let n = 0;
  const send = async (): Promise<SendResult> => (++n === 1 ? { code: 3, stderr: "missing scope" } : { code: 0 });
  const calls: string[] = [];
  const wrapped = async (args: string[]) => {
    calls.push(argMap(args)["--markdown"]);
    return send();
  };
  const s = new LarkSender({ chatId: "oc_1", send: wrapped, log: (m) => logs.push(m) });
  s.enqueue("first");
  s.enqueue("second");
  await s.whenIdle();
  expect(calls).toEqual(["first", "second"]); // continued past the failure
  expect(logs.some((l) => l.includes("code 3") && l.includes("missing scope"))).toBe(true);
});

test("default idempotency key is deterministic; explicit key overrides", async () => {
  expect(defaultIdempotencyKey("oc_1", "hi")).toBe(defaultIdempotencyKey("oc_1", "hi"));
  expect(defaultIdempotencyKey("oc_1", "hi")).not.toBe(defaultIdempotencyKey("oc_1", "bye"));
  const { send, calls } = recordingSend();
  const s = new LarkSender({ chatId: "oc_1", send });
  s.enqueue("hi", "turn-7-flush-2");
  await s.whenIdle();
  expect(argMap(calls[0])["--idempotency-key"]).toBe("turn-7-flush-2");
});

test("stop() drops queued messages and blocks further enqueues", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slowSend = async (args: string[]): Promise<SendResult> => {
    calls.push(argMap(args)["--markdown"]);
    await gate;
    return { code: 0 };
  };
  const s = new LarkSender({ chatId: "oc_1", send: slowSend });
  s.enqueue("a"); // starts sending, awaits gate
  s.enqueue("b"); // queued
  s.stop(); // drops "b"
  s.enqueue("c"); // ignored after stop
  release();
  await s.whenIdle();
  expect(calls).toEqual(["a"]); // only the in-flight "a" went out
});
