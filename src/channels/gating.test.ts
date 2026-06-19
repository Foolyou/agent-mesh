import { test, expect } from "bun:test";
import { senderAllowed, passesAtGate, stripBotMention } from "./gating";
import type { FeishuChannelConfig, InboundMsg } from "./types";

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

function msg(over: Partial<InboundMsg> = {}): InboundMsg {
  return { eventId: "e1", chatId: "oc_1", chatType: "p2p", senderId: "ou_me", messageType: "text", text: "hi", mentions: [], ...over };
}

test("senderAllowed only passes whitelisted open_ids", () => {
  expect(senderAllowed(cfg(), "ou_me")).toBe(true);
  expect(senderAllowed(cfg(), "ou_stranger")).toBe(false);
  expect(senderAllowed(cfg({ allowSenders: [] }), "ou_me")).toBe(false); // empty => nothing passes
});

test("passesAtGate always passes p2p", () => {
  expect(passesAtGate(msg({ chatType: "p2p", text: "hello" }), cfg())).toBe(true);
});

test("passesAtGate prefers structured mention id for group text", () => {
  const c = cfg({ botMentionId: "ou_bot", botName: "Old Name" });
  expect(passesAtGate(msg({ chatType: "group", text: "@Legion do it", mentions: [{ key: "_user_1", id: "ou_bot", name: "Legion" }] }), c)).toBe(true);
  expect(passesAtGate(msg({ chatType: "group", text: "@Old Name do it", mentions: [{ key: "_user_1", id: "ou_other", name: "Old Name" }] }), c)).toBe(false);
});

test("passesAtGate falls back to rendered bot mention when no id is configured", () => {
  expect(passesAtGate(msg({ chatType: "group", text: "@MeshBot do the thing" }), cfg())).toBe(true);
  expect(passesAtGate(msg({ chatType: "group", text: "just chatting" }), cfg())).toBe(false);
});

test("passesAtGate can allow trusted bound group messages without @", () => {
  expect(passesAtGate(msg({ chatType: "group", text: "just chatting" }), cfg({ requireMention: false }))).toBe(true);
});

test("passesAtGate trusts the scope contract when botName is empty", () => {
  expect(passesAtGate(msg({ chatType: "group", text: "no mention here" }), cfg({ botName: "" }))).toBe(true);
});

test("stripBotMention removes a leading @bot from group text only", () => {
  expect(stripBotMention(msg({ chatType: "group", text: "@MeshBot hello there" }), cfg())).toBe("hello there");
  expect(stripBotMention(msg({ chatType: "group", text: "  @MeshBot   spaced" }), cfg())).toBe("spaced");
  expect(stripBotMention(
    msg({ chatType: "group", text: "@Legion hello", mentions: [{ key: "_user_1", id: "ou_bot", name: "Legion" }] }),
    cfg({ botMentionId: "ou_bot", botName: "" }),
  )).toBe("hello");
});

test("stripBotMention leaves p2p text and mid-text mentions intact", () => {
  expect(stripBotMention(msg({ chatType: "p2p", text: "@MeshBot hi" }), cfg())).toBe("@MeshBot hi");
  expect(stripBotMention(msg({ chatType: "group", text: "hey @MeshBot here" }), cfg())).toBe("hey @MeshBot here");
  expect(stripBotMention(msg({ chatType: "group", text: "@MeshBot hi" }), cfg({ botName: "" }))).toBe("@MeshBot hi"); // no botName/id => no-op
});
