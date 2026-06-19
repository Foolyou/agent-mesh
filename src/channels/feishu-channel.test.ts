import { test, expect } from "bun:test";
import { FeishuChannel } from "./feishu-channel";
import type { MeshGateway, FeishuChannelConfig, InboundMsg } from "./types";
import type { MeshEvent } from "../acp/types";

function cfg(over: Partial<FeishuChannelConfig> = {}): FeishuChannelConfig {
  return {
    enabled: true,
    appId: "cli_1",
    appSecret: "secret",
    domain: "feishu",
    mesh: "feishu-poc",
    chatId: "oc_1",
    botMentionId: "",
    botName: "MeshBot",
    requireMention: true,
    allowSenders: ["ou_me"],
    outbound: { minIntervalMs: 0 },
    websocket: {},
    bindings: [{ mesh: "feishu-poc", chatId: "oc_1" }],
    ...over,
  };
}

class FakeMesh implements MeshGateway {
  listeners: ((name: string, e: MeshEvent) => void)[] = [];
  prompts: { name: string; text: string }[] = [];
  running = true;
  startCalls = 0;
  stopCalls = 0;
  newSessionCalls = 0;
  failStart = false;
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
  async startMesh() {
    this.startCalls++;
    if (this.failStart) throw new Error("boom");
    this.running = true;
  }
  async stopMesh() {
    this.stopCalls++;
    this.running = false;
  }
  async newAllSessions() {
    this.newSessionCalls++;
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
    idempotencyKey: (binding, seq) => `${binding.mesh}:${seq}`,
  });
  ch.start();
  return { ch, mesh, sent, isStopped, push: (m: InboundMsg) => pushInbound(m), timers, started: () => consumerStarted, consumerStopped: () => consumerStopped };
}

function setupDefaultIdempotency() {
  const mesh = new FakeMesh();
  const { sink, sent } = fakeSender();
  const timers = manualTimers();
  const ch = new FeishuChannel({
    mesh,
    config: cfg(),
    sender: sink,
    makeConsumer: () => ({ start() {}, stop() {} }),
    debounceMs: 800,
    setTimer: timers.setTimer,
  });
  ch.start();
  return { ch, mesh, sent, timers };
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
  return { eventId: "e1", chatId: "oc_1", chatType: "p2p", senderId: "ou_me", messageType: "text", text: "hi", mentions: [], ...over };
}
function chunk(agent: string, text: string, messageId?: string): MeshEvent {
  return {
    kind: "update",
    agent,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) },
    ts: "t",
  } as MeshEvent;
}
function chunkContent(agent: string, content: unknown, messageId?: string): MeshEvent {
  return {
    kind: "update",
    agent,
    update: { sessionUpdate: "agent_message_chunk", content, ...(messageId ? { messageId } : {}) },
    ts: "t",
  } as MeshEvent;
}
function idle(agent: string): MeshEvent {
  return { kind: "agent_activity", agent, activity: "idle", ts: "t" } as MeshEvent;
}
function toolCall(agent: string, toolCallId?: string, title?: string, sessionUpdate: "tool_call" | "tool_call_update" = "tool_call"): MeshEvent {
  return {
    kind: "update",
    agent,
    update: { sessionUpdate, ...(toolCallId ? { toolCallId } : {}), ...(title ? { title } : {}) },
    ts: "t",
  } as MeshEvent;
}
function replayStarted(agent: string): MeshEvent {
  return { kind: "replay_started", agent, ts: "t" } as MeshEvent;
}
function replayFinished(agent: string): MeshEvent {
  return { kind: "replay_finished", agent, ts: "t" } as MeshEvent;
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ── inbound ──────────────────────────────────────────────────────────────────

test("inbound: whitelisted p2p message feeds the router with the feishu prefix", async () => {
  const s = setup();
  s.push(inbound({ text: "hello" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toHaveLength(1);
  expect(s.mesh.prompts[0].name).toBe("feishu-poc");
  expect(s.mesh.prompts[0].text).toContain("来自飞书授权群聊的用户消息");
  expect(s.mesh.prompts[0].text).toContain("用户消息：hello");
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
  expect(s.mesh.prompts).toHaveLength(1);
  expect(s.mesh.prompts[0].text).toContain("用户消息：real");
});

test("inbound: group message without @bot is ignored; with @bot it is stripped and fed", async () => {
  const s = setup();
  s.push(inbound({ eventId: "g1", chatType: "group", text: "just chatting" }));
  s.push(inbound({ eventId: "g2", chatType: "group", text: "@MeshBot do it" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toHaveLength(1);
  expect(s.mesh.prompts[0].text).toContain("用户消息：do it");
});

test("inbound: configured trusted group can skip @bot gate", async () => {
  const s = setup({ requireMention: false });
  s.push(inbound({ eventId: "g-open", chatType: "group", text: "just chatting" }));
  await Promise.resolve();
  expect(s.mesh.prompts).toHaveLength(1);
  expect(s.mesh.prompts[0].text).toContain("用户消息：just chatting");
});

test("multiple bindings route inbound and outbound by chat and mesh", async () => {
  const listeners: ((name: string, e: MeshEvent) => void)[] = [];
  const prompts: { name: string; text: string }[] = [];
  const senderA = fakeSender();
  const senderB = fakeSender();
  let pushInbound!: (m: InboundMsg) => void;
  const ch = new FeishuChannel({
    mesh: {
      on(l) {
        listeners.push(l);
        return () => {};
      },
      async promptRouter(name, text) {
        prompts.push({ name, text });
      },
      async startMesh() {},
      async stopMesh() {},
      async newAllSessions() {},
      routerOf(name) {
        return name === "mesh-b" ? "router-b" : "router-a";
      },
      listMeshes() {
        return [
          { name: "mesh-a", status: "running" },
          { name: "mesh-b", status: "running" },
        ];
      },
    },
    config: cfg({
      mesh: "mesh-a",
      chatId: "oc_a",
      requireMention: false,
      bindings: [
        { mesh: "mesh-a", chatId: "oc_a" },
        { mesh: "mesh-b", chatId: "oc_b" },
      ],
    }),
    senders: new Map([
      ["oc_a", senderA.sink],
      ["oc_b", senderB.sink],
    ]),
    idempotencyKey: (binding, seq) => `${binding.mesh}:${seq}`,
    makeConsumer: (onMessage) => {
      pushInbound = onMessage;
      return { start() {}, stop() {} };
    },
  });
  ch.start();

  pushInbound(inbound({ chatId: "oc_b", chatType: "group", text: "hello b" }));
  await Promise.resolve();
  expect(prompts[0].name).toBe("mesh-b");

  for (const l of listeners) l("mesh-b", chunk("router-b", "B"));
  for (const l of listeners) l("mesh-b", idle("router-b"));
  for (const l of listeners) l("mesh-a", chunk("router-a", "A"));
  for (const l of listeners) l("mesh-a", idle("router-a"));
  expect(senderB.sent).toEqual([{ text: "B", key: "mesh-b:0" }]);
  expect(senderA.sent).toEqual([{ text: "A", key: "mesh-a:0" }]);
});

test("inbound: group @ gate can use mention id instead of display name", async () => {
  const s = setup({ botMentionId: "ou_bot", botName: "StaleName" });
  s.push(inbound({
    eventId: "g-id",
    chatType: "group",
    text: "@Legion do it",
    mentions: [{ key: "_user_1", id: "ou_bot", name: "Legion" }],
  }));
  await Promise.resolve();
  expect(s.mesh.prompts).toHaveLength(1);
  expect(s.mesh.prompts[0].text).toContain("用户消息：do it");
});

test("inbound: a stopped mesh is auto-started before routing the message", async () => {
  const s = setup();
  s.mesh.running = false;
  s.push(inbound({ text: "anyone home?" }));
  await flushAsync();
  expect(s.mesh.startCalls).toBe(1);
  expect(s.mesh.prompts).toHaveLength(1);
  expect(s.mesh.prompts[0].text).toContain("用户消息：anyone home?");
  expect(s.sent).toHaveLength(0);
});

test("inbound: an auto-start failure is reported to the bound chat", async () => {
  const s = setup();
  s.mesh.running = false;
  s.mesh.failStart = true;
  s.push(inbound({ text: "anyone home?" }));
  await flushAsync();
  expect(s.mesh.prompts).toHaveLength(0);
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0].text).toContain("自动启动失败");
});

test("command: /mesh status reports the bound mesh status without prompting the router", async () => {
  const s = setup();
  s.push(inbound({ text: "/mesh status" }));
  await flushAsync();
  expect(s.mesh.prompts).toHaveLength(0);
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0].text).toContain("running");
});

test("command: /mesh stop stops the bound mesh", async () => {
  const s = setup();
  s.push(inbound({ text: "/mesh stop" }));
  await flushAsync();
  expect(s.mesh.stopCalls).toBe(1);
  expect(s.mesh.running).toBe(false);
  expect(s.sent[0].text).toContain("已停止");
});

test("command: /mesh start starts a stopped bound mesh", async () => {
  const s = setup();
  s.mesh.running = false;
  s.push(inbound({ text: "/mesh start" }));
  await flushAsync();
  expect(s.mesh.startCalls).toBe(1);
  expect(s.mesh.running).toBe(true);
  expect(s.sent[0].text).toContain("已启动");
});

test("command: /mesh new-session opens fresh sessions without routing the command", async () => {
  const s = setup();
  s.push(inbound({ text: "/mesh new-session" }));
  await flushAsync();
  expect(s.mesh.newSessionCalls).toBe(1);
  expect(s.mesh.prompts).toHaveLength(0);
  expect(s.sent[0].text).toContain("新 session");
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

test("outbound: default Feishu idempotency keys do not reset to mesh:seq across channel restarts", async () => {
  const first = setupDefaultIdempotency();
  first.mesh.emit("feishu-poc", chunk("router", "one"));
  first.mesh.emit("feishu-poc", idle("router"));
  await first.ch.stop();

  const second = setupDefaultIdempotency();
  second.mesh.emit("feishu-poc", chunk("router", "two"));
  second.mesh.emit("feishu-poc", idle("router"));

  expect(first.sent[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(second.sent[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(second.sent[0].key).not.toBe(first.sent[0].key);
  expect(second.sent[0].key).not.toBe("feishu-poc:0");
});

test("outbound: session replay is not mirrored to Feishu and clears pending text", () => {
  const s = setup();
  s.mesh.emit("feishu-poc", chunk("router", "pending-live"));
  s.mesh.emit("feishu-poc", replayStarted("router"));
  s.mesh.emit("feishu-poc", chunk("router", "old replayed answer"));
  s.mesh.emit("feishu-poc", idle("router"));
  s.mesh.emit("feishu-poc", replayFinished("router"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toHaveLength(0);

  s.mesh.emit("feishu-poc", chunk("router", "fresh"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toEqual([{ text: "fresh", key: "feishu-poc:0" }]);
});

test("outbound: extracts text from nested ACP content blocks", () => {
  const s = setup();
  s.mesh.emit("feishu-poc", chunkContent("router", {
    type: "message",
    content: [
      { type: "text", text: "Hello" },
      { content: { type: "text", text: " world" } },
    ],
  }));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toEqual([{ text: "Hello world", key: "feishu-poc:0" }]);
});

test("outbound: drops Claude same-messageId full resend duplicates", () => {
  const s = setup();
  s.mesh.emit("feishu-poc", chunk("router", "Hello", "mid-1"));
  s.mesh.emit("feishu-poc", chunk("router", "Hello", "mid-1"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toEqual([{ text: "Hello", key: "feishu-poc:0" }]);
});

test("outbound: replaces partial Claude chunks when the same messageId sends the full text", () => {
  const s = setup();
  s.mesh.emit("feishu-poc", chunk("router", "Hel", "mid-1"));
  s.mesh.emit("feishu-poc", chunk("router", "lo", "mid-1"));
  s.mesh.emit("feishu-poc", chunk("router", "Hello", "mid-1"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toEqual([{ text: "Hello", key: "feishu-poc:0" }]);
});

test("outbound: drops no-messageId full resend duplicates", () => {
  const s = setup();
  s.mesh.emit("feishu-poc", chunk("router", "你好！有什么可以帮你的吗？"));
  s.mesh.emit("feishu-poc", chunk("router", "你好！有什么可以帮你的吗？"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toEqual([{ text: "你好！有什么可以帮你的吗？", key: "feishu-poc:0" }]);
});

test("outbound: replaces no-messageId partial chunks when the full text is resent", () => {
  const s = setup();
  s.mesh.emit("feishu-poc", chunk("router", "你好！"));
  s.mesh.emit("feishu-poc", chunk("router", "你好！有什么可以帮你的吗？"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toEqual([{ text: "你好！有什么可以帮你的吗？", key: "feishu-poc:0" }]);
});

test("outbound: preserves repeated text from different messageIds", () => {
  const s = setup();
  s.mesh.emit("feishu-poc", chunk("router", "Hi", "mid-a"));
  s.mesh.emit("feishu-poc", chunk("router", "Hi", "mid-b"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.sent).toEqual([{ text: "HiHi", key: "feishu-poc:0" }]);
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

// ── outbound: true streaming (in-place edit) ───────────────────────────────────

function streamingSink() {
  const updates: string[] = [];
  let commits = 0;
  const enqueued: string[] = [];
  const segments: ({ toolName?: string } | undefined)[] = [];
  return {
    sink: {
      enqueue: (text: string) => enqueued.push(text),
      stop: () => {},
      streamUpdate: (t: string) => updates.push(t),
      streamCommit: () => { commits++; },
      streamSegmentBreak: (meta?: { toolName?: string }) => segments.push(meta),
    },
    updates,
    enqueued,
    segments,
    commits: () => commits,
  };
}

function setupStreaming(over: Partial<FeishuChannelConfig> = {}) {
  const mesh = new FakeMesh();
  const ss = streamingSink();
  const timers = manualTimers();
  const ch = new FeishuChannel({
    mesh,
    config: cfg(over),
    sender: ss.sink,
    makeConsumer: () => ({ start() {}, stop() {} }),
    setTimer: timers.setTimer,
  });
  ch.start();
  return { ch, mesh, ...ss };
}

test("streaming: router chunks drive in-place edits and idle commits the turn", () => {
  const s = setupStreaming();
  s.mesh.emit("feishu-poc", chunk("router", "Hel"));
  s.mesh.emit("feishu-poc", chunk("router", "lo"));
  expect(s.updates).toEqual(["Hel", "Hello"]); // grows in place, no debounce wait
  expect(s.commits()).toBe(0);
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.updates).toEqual(["Hel", "Hello", "Hello"]); // final flush
  expect(s.commits()).toBe(1); // sealed at the turn boundary
});

test("streaming: a new turn starts a fresh message", () => {
  const s = setupStreaming();
  s.mesh.emit("feishu-poc", chunk("router", "one"));
  s.mesh.emit("feishu-poc", idle("router"));
  s.mesh.emit("feishu-poc", chunk("router", "two"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.commits()).toBe(2);
});

test("streaming: disabled via config falls back to one-shot enqueue", () => {
  const s = setupStreaming({ outbound: { minIntervalMs: 0, streaming: false } });
  s.mesh.emit("feishu-poc", chunk("router", "Hi"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.updates).toEqual([]); // streaming not used
  expect(s.enqueued).toEqual(["Hi"]);
});

// ── outbound: in-turn segmentation on router tool calls ────────────────────────

test("streaming: a router tool_call seals the segment; following text is a new segment", () => {
  const s = setupStreaming();
  s.mesh.emit("feishu-poc", chunk("router", "Before"));
  s.mesh.emit("feishu-poc", toolCall("router", "call-1", "bash"));
  s.mesh.emit("feishu-poc", chunk("router", " after"));
  s.mesh.emit("feishu-poc", idle("router"));
  expect(s.segments).toEqual([{ toolName: "bash" }]); // exactly one in-turn break
  expect(s.commits()).toBe(1); // and one hard commit at idle (still one turn)
});

test("streaming: consecutive tool_call_update for the same call segment only once", () => {
  const s = setupStreaming();
  s.mesh.emit("feishu-poc", chunk("router", "x"));
  s.mesh.emit("feishu-poc", toolCall("router", "call-1", "bash", "tool_call"));
  s.mesh.emit("feishu-poc", toolCall("router", "call-1", undefined, "tool_call_update"));
  s.mesh.emit("feishu-poc", toolCall("router", "call-1", undefined, "tool_call_update"));
  expect(s.segments).toHaveLength(1);
});

test("streaming: a different tool call id segments again", () => {
  const s = setupStreaming();
  s.mesh.emit("feishu-poc", chunk("router", "a"));
  s.mesh.emit("feishu-poc", toolCall("router", "call-1", "bash"));
  s.mesh.emit("feishu-poc", chunk("router", "b"));
  s.mesh.emit("feishu-poc", toolCall("router", "call-2", "grep"));
  expect(s.segments).toEqual([{ toolName: "bash" }, { toolName: "grep" }]);
});

test("streaming: tool-call de-dup resets across turns", () => {
  const s = setupStreaming();
  s.mesh.emit("feishu-poc", chunk("router", "a"));
  s.mesh.emit("feishu-poc", toolCall("router", "call-1", "bash"));
  s.mesh.emit("feishu-poc", idle("router")); // turn ends, de-dup resets
  s.mesh.emit("feishu-poc", chunk("router", "b"));
  s.mesh.emit("feishu-poc", toolCall("router", "call-1", "bash")); // same id, new turn
  expect(s.segments).toHaveLength(2);
});

test("streaming disabled: a tool_call does not segment", () => {
  const s = setupStreaming({ outbound: { minIntervalMs: 0, streaming: false } });
  s.mesh.emit("feishu-poc", chunk("router", "x"));
  s.mesh.emit("feishu-poc", toolCall("router", "call-1", "bash"));
  expect(s.segments).toEqual([]);
});
