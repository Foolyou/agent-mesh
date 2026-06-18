import { test, expect } from "bun:test";
import { LarkConsumer, parseInbound, parseErrorEnvelope, READY_MARKER, type ConsumerHandle, type SpawnHooks } from "./consumer";
import type { InboundMsg } from "./types";

// ── fake subprocess + manual clock so handshake/backoff/teardown are deterministic ──

class FakeChild {
  hooks!: SpawnHooks;
  terminateCount = 0;
  stdinClosedCount = 0;
  private resolveExit!: (code: number | null) => void;
  exited = new Promise<number | null>((r) => (this.resolveExit = r));

  terminate(): void {
    this.terminateCount++;
  }
  closeStdin(): void {
    this.stdinClosedCount++;
  }
  // test drivers
  emitStderr(line: string): void {
    this.hooks.onStderrLine(line);
  }
  emitStdout(line: string): void {
    this.hooks.onStdoutLine(line);
  }
  exit(code: number | null): void {
    this.resolveExit(code);
  }
}

function fakeSpawn(): { spawn: (hooks: SpawnHooks) => ConsumerHandle; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn = (hooks: SpawnHooks): ConsumerHandle => {
    const c = new FakeChild();
    c.hooks = hooks;
    children.push(c);
    return c;
  };
  return { spawn, children };
}

function manualTimers() {
  let clock = 0;
  let nid = 1;
  const timers: { id: number; fn: () => void; at: number }[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const id = nid++;
    timers.push({ id, fn, at: clock + ms });
    return () => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    };
  };
  const now = () => clock;
  const setClock = (t: number) => {
    clock = t;
  };
  const advance = (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      const t = due[0];
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { setTimer, now, advance, setClock, pending: () => timers.length };
}

const READY = `${READY_MARKER}im.message.receive_v1`;
function inboundLine(over: Partial<Record<string, string>> = {}): string {
  return JSON.stringify({ event_id: "e1", chat_id: "oc_1", sender_id: "ou_me", chat_type: "p2p", message_type: "text", content: "hi", ...over });
}
// `handle.exited.then(onExit)` runs onExit on a microtask, so after a fake exit() we must let
// the microtask queue drain before inspecting/advancing the (synchronous) manual timers.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

test("parseInbound maps fields and rejects malformed / incomplete events", () => {
  const msg = parseInbound(inboundLine({ content: "hello", chat_type: "group" }));
  expect(msg).toEqual({ eventId: "e1", chatId: "oc_1", chatType: "group", senderId: "ou_me", messageType: "text", text: "hello" } as InboundMsg);
  expect(parseInbound("not json")).toBeUndefined();
  expect(parseInbound(JSON.stringify({ chat_id: "oc_1" }))).toBeUndefined(); // missing event_id/sender/type
  expect(parseInbound(JSON.stringify({ event_id: "e", chat_id: "c", sender_id: "s", chat_type: "weird" }))).toBeUndefined();
});

test("parseErrorEnvelope reads structured envelopes, ignores plain lines", () => {
  expect(parseErrorEnvelope(JSON.stringify({ ok: false, error: { type: "auth", subtype: "missing_scope", hint: "add scope" } }))).toBe("auth / missing_scope / add scope");
  expect(parseErrorEnvelope("[event] ready event_key=x")).toBeUndefined();
  expect(parseErrorEnvelope(JSON.stringify({ ok: true }))).toBeUndefined();
});

test("handshake gate: stdout is NOT processed before the ready marker", () => {
  const { spawn, children } = fakeSpawn();
  const got: InboundMsg[] = [];
  const c = new LarkConsumer({ spawn, onMessage: (m) => got.push(m), ...manualTimers() });
  c.start();
  const child = children[0];

  // stdout arriving BEFORE ready must be ignored entirely (no sleep, pure gate).
  child.emitStdout(inboundLine({ event_id: "early" }));
  expect(got).toHaveLength(0);
  expect(c.isReady).toBe(false);

  // ready marker on stderr flips the gate; subsequent stdout is processed.
  child.emitStderr(READY);
  expect(c.isReady).toBe(true);
  child.emitStdout(inboundLine({ event_id: "after" }));
  expect(got).toHaveLength(1);
  expect(got[0].eventId).toBe("after");
});

test("backoff: non-fatal exit reconnects with growing delay, no tight loop", async () => {
  const { spawn, children } = fakeSpawn();
  const timers = manualTimers();
  const c = new LarkConsumer({ spawn, onMessage: () => {}, backoff: { baseMs: 1000, maxMs: 30000, resetAfterMs: 10000 }, random: () => 0, ...timers });
  c.start();
  expect(children).toHaveLength(1);

  // first exit (code 5 network): delay = base * 2^0 = 1000ms
  children[0].emitStderr(READY);
  children[0].exit(5);
  await flush();
  timers.advance(999);
  expect(children).toHaveLength(1); // not yet
  timers.advance(1);
  expect(children).toHaveLength(2); // reconnected at 1000ms

  // second exit without staying ready long: delay grows to base * 2^1 = 2000ms
  children[1].exit(5);
  await flush();
  timers.advance(1999);
  expect(children).toHaveLength(2);
  timers.advance(1);
  expect(children).toHaveLength(3);
});

test("backoff resets after the child stayed ready past resetAfterMs", async () => {
  const { spawn, children } = fakeSpawn();
  const timers = manualTimers();
  const c = new LarkConsumer({ spawn, onMessage: () => {}, backoff: { baseMs: 1000, maxMs: 30000, resetAfterMs: 10000 }, random: () => 0, ...timers });
  c.start();

  // exit once to bump attempts to 1 (next would be 2000ms)
  children[0].emitStderr(READY);
  children[0].exit(5);
  await flush();
  timers.advance(1000);
  expect(children).toHaveLength(2);

  // second child becomes ready and stays up >= resetAfterMs before exiting => attempts reset.
  children[1].emitStderr(READY); // readyAt = current clock
  timers.setClock(timers.now() + 15000); // 15s of uptime
  children[1].exit(5);
  await flush();
  // reset => delay back to base * 2^0 = 1000ms (not 2000ms)
  timers.advance(999);
  expect(children).toHaveLength(2);
  timers.advance(1);
  expect(children).toHaveLength(3);
});

test("fatal exit codes 2 and 3 do NOT reconnect (no tight loop)", async () => {
  for (const code of [2, 3]) {
    const { spawn, children } = fakeSpawn();
    const timers = manualTimers();
    const c = new LarkConsumer({ spawn, onMessage: () => {}, ...timers });
    c.start();
    children[0].emitStderr(JSON.stringify({ ok: false, error: { type: code === 3 ? "auth" : "validation" } }));
    children[0].exit(code);
    await flush();
    timers.advance(60000);
    expect(children).toHaveLength(1); // never respawned
    expect(timers.pending()).toBe(0); // no backoff timer armed
  }
});

test("teardown: stop() closes stdin + SIGTERMs, awaits exit, and prevents any reconnect", async () => {
  const { spawn, children } = fakeSpawn();
  const timers = manualTimers();
  const c = new LarkConsumer({ spawn, onMessage: () => {}, ...timers });
  c.start();
  children[0].emitStderr(READY);

  // stdin must NOT be closed while the consumer is running normally.
  expect(children[0].stdinClosedCount).toBe(0);

  const stopped = c.stop();
  expect(children[0].stdinClosedCount).toBe(1); // graceful EOF on teardown
  expect(children[0].terminateCount).toBe(1); // exactly one SIGTERM so far
  children[0].exit(null); // child honors the graceful stop
  await stopped;

  // the exit handler must NOT schedule a reconnect after stop()
  expect(timers.pending()).toBe(0);
  expect(children).toHaveLength(1);

  // a late start() is a no-op once stopped
  c.start();
  expect(children).toHaveLength(1);
});

test("teardown grace: a stuck child gets a SECOND SIGTERM, never SIGKILL", async () => {
  const { spawn, children } = fakeSpawn();
  const timers = manualTimers();
  const c = new LarkConsumer({ spawn, onMessage: () => {}, teardownGraceMs: 5000, ...timers });
  c.start();
  children[0].emitStderr(READY);

  const stopped = c.stop();
  expect(children[0].terminateCount).toBe(1);

  // child ignores the first signals; grace window elapses => one more stdin-close + SIGTERM
  // (no SIGKILL path exists).
  expect(children[0].stdinClosedCount).toBe(1);
  timers.advance(5000);
  expect(children[0].terminateCount).toBe(2);
  expect(children[0].stdinClosedCount).toBe(2);

  // FakeChild has no kill(9) capability at all — the absence proves teardown can't SIGKILL.
  expect(typeof (children[0] as any).kill).toBe("undefined");

  children[0].exit(null);
  await stopped;
});
