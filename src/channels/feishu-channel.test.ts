import { test, expect } from "bun:test";
import { FeishuChannel } from "./feishu-channel";
import type { MeshGateway, FeishuChannelConfig, InboundMsg } from "./types";
import type { MeshEvent } from "../acp/types";

function cfg(over: Partial<FeishuChannelConfig> = {}): FeishuChannelConfig {
  return { enabled: true, mesh: "feishu-poc", chatId: "oc_1", botName: "MeshBot", allowSenders: ["ou_me"], outbound: { minIntervalMs: 0 }, ...over };
}

class FakeMesh implements MeshGateway {
  listeners: ((name: string, e: MeshEvent) => void)[] = [];
  prompts: { name: string; text: string }[] = [];
  running = true;
  router = "router";
  on(l: (name: string, e: MeshEvent) => void) {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }
  async promptRouter(name: string, text: string) {
    if (!this.running) throw new Error(`mesh "${name}" is not running`);
    this.prompts.push({ name, text });
  }
  routerOf() {
    return this.router;
  }
  listMeshes() {
    return [{ name: "feishu-poc", status: this.running ? "running" : "stopped" }];
  }
  emit(name: string, e: MeshEvent) {
    for (const l of [...this.listeners]) l(name, e);
  }
}

function fakeSender() {
  const sent: { text: string; key?: string }[] = [];
  let stopped = false;
  return { sink: { enqueue: (text: string, key?: string) => sent.push({ text, key }), stop: () => (stopped = true) }, sent, isStopped: () => stopped };
}

function setup(over: Partial<FeishuChannelConfig> = {}, opts: { debounceMs?: number } = {}) {
  const mesh = new FakeMesh();
  const { sink, sent, isStopped } = fakeSender();
  let pushInbound!: (m: InboundMsg) => void;
  let consumerStarted = false;
  let consumerStopped = false;
  const timers = manualTimers();
  const ch = new FeishuChannel({
    mesh,
    config: cfg(over),
    sender: sink,
    makeConsumer: (onMessage) => {
      pushInbound = onMessage;
      return {
        start: () => {
          consumerStarted = true;
        },
        stop: () => {
          consumerStopped = true;
        },
      };
    },
    debounceMs: opts.debounceMs ?? 800,
    setTimer: timers.setTimer,
  });
  ch.start();
  return { ch, mesh, sent, isStopped, push: (m: InboundMsg) => pushInbound(m), timers, started: () => consumerStarted, consumerStopped: () => consumerStopped };
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
  return { setTimer, advance };
}

function inbound(over: Partial<InboundMsg> = {}): InboundMsg {
  return { eventId: "e1", chatId: "oc_1", chatType: "p2p", senderId: "ou_me", messageType: "text", text: "hi", ...over };
}
function chunk(agent: string, text: string): MeshEvent {
  return { kind: "update", agent, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, ts: "t" } as MeshEvent;
}
function idle(agent: string): MeshEvent {
  return { kind: "agent_activity", agent, activity: "idle", ts: "t" } as MeshEvent;
}

// ── inbound ──────────────────────────────────────────────────────────────────

test("inbound: whitelisted p2p message feeds the router with the feishu prefix", async () => {
  const s = setup();
  s.push(inbound({ text: "hello" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toEqual([{ name: "feishu-poc", text: "[飞书消息] hello" }]);
  expect(s.started()).toBe(true);
});

test("inbound: duplicate event_id is fed only once", async () => {
  const s = setup();
  s.push(inbound({ eventId: "dup", text: "a" }));
  s.push(inbound({ eventId: "dup", text: "a" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toHaveLength(1);
});

test("inbound: non-whitelisted sender is ignored", async () => {
  const s = setup();
  s.push(inbound({ senderId: "ou_stranger" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toHaveLength(0);
});

test("inbound: a p2p message from a different chat is silently ignored", async () => {
  const s = setup(); // bound chatId = oc_1
  s.push(inbound({ chatId: "oc_other", text: "hi from elsewhere" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toHaveLength(0);
  expect(s.sent).toHaveLength(0); // no prompt AND no outbound (not even a hint)
});

test("inbound: a group message from a different chat is silently ignored", async () => {
  const s = setup();
  s.push(inbound({ chatId: "oc_other", chatType: "group", text: "@MeshBot do it" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toHaveLength(0);
  expect(s.sent).toHaveLength(0);
});

test("inbound: a wrong-chat event does not consume dedup capacity for the bound chat", async () => {
  const s = setup();
  // The same event_id arrives first from the wrong chat, then for the bound chat: the bound one
  // must still be processed because the wrong-chat one was dropped BEFORE dedup.
  s.push(inbound({ eventId: "shared", chatId: "oc_other", text: "noise" }));
  s.push(inbound({ eventId: "shared", chatId: "oc_1", text: "real" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toEqual([{ name: "feishu-poc", text: "[飞书消息] real" }]);
});

test("inbound: group message without @bot is ignored; with @bot it is stripped and fed", async () => {
  const s = setup();
  s.push(inbound({ eventId: "g1", chatType: "group", text: "just chatting" }));
  s.push(inbound({ eventId: "g2", chatType: "group", text: "@MeshBot do it" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toEqual([{ name: "feishu-poc", text: "[飞书消息] do it" }]);
});

test("inbound: a stopped mesh is NOT started — a hint is sent instead", async () => {
  const s = setup();
  s.mesh.running = false;
  s.push(inbound({ text: "anyone home?" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toHaveLength(0);
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0].text).toContain("未运行");
});

// ── outbound ─────────────────────────────────────────────────────────────────

test("outbound: router chunks aggregate and flush on turn-idle", () => {
  const s = setup();
  s.mesh.emit("feishu-poc", chunk("router", "Hel"));
  s.mesh.emit("feishu-poc", chunk("router", "lo"));
  expect(s.sent).toHaveLength(0); // not until the boundary
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toEqual([{ text: "Hello", key: "feishu-poc:0" }]);
});

test("outbound: debounce flushes without an explicit idle", () => {
  const s = setup({}, { debounceMs: 800 });
  s.mesh.emit("feishu-poc", chunk("router", "ping"));
  s.timers.advance(799);
  expect(s.sent).toHaveLength(0);
  s.timers.advance(1);
  expect(s.sent).toEqual([{ text: "ping", key: "feishu-poc:0" }]);
});

test("outbound: only the router agent of the bound mesh is mirrored", () => {
  const s = setup();
  s.mesh.emit("other-mesh", chunk("router", "nope")); // wrong mesh
  s.mesh.emit("feishu-poc", chunk("worker", "nope")); // non-router agent
  s.mesh.emit("feishu-poc", { kind: "mail", from: "router", to: "worker", body: "internal", ts: "t" } as MeshEvent); // mail not mirrored
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toHaveLength(0);
});

test("outbound: empty flush is never sent", () => {
  const s = setup();
  s.mesh.emit("feishu-poc", chunk("router", "   ")); // whitespace only
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toHaveLength(0);
});

test("stop() unsubscribes, stops the consumer and sender", async () => {
  const s = setup();
  await s.ch.stop();
  expect(s.consumerStopped()).toBe(true);
  expect(s.isStopped()).toBe(true);
  s.mesh.emit("feishu-poc", chunk("router", "after-stop"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toHaveLength(0); // no longer subscribed
});
