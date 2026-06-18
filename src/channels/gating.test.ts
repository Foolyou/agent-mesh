import { test, expect } from "bun:test";
import { senderAllowed, passesAtGate, stripBotMention } from "./gating";
import type { FeishuChannelConfig, InboundMsg } from "./types";

function cfg(over: Partial<FeishuChannelConfig> = {}): FeishuChannelConfig {
  return { enabled: true, mesh: "feishu-poc", chatId: "oc_1", botName: "MeshBot", allowSenders: ["ou_me"], outbound: { minIntervalMs: 0 }, ...over };
}

function msg(over: Partial<InboundMsg> = {}): InboundMsg {
  return { eventId: "e1", chatId: "oc_1", chatType: "p2p", senderId: "ou_me", messageType: "text", text: "hi", ...over };
}

test("senderAllowed only passes whitelisted open_ids", () => {
  expect(senderAllowed(cfg(), "ou_me")).toBe(true);
  expect(senderAllowed(cfg(), "ou_stranger")).toBe(false);
  expect(senderAllowed(cfg({ allowSenders: [] }), "ou_me")).toBe(false); // empty => nothing passes
});

test("passesAtGate always passes p2p", () => {
  expect(passesAtGate(msg({ chatType: "p2p", text: "hello" }), "MeshBot")).toBe(true);
});

test("passesAtGate requires the rendered bot mention in group text when botName set", () => {
  expect(passesAtGate(msg({ chatType: "group", text: "@MeshBot do the thing" }), "MeshBot")).toBe(true);
  expect(passesAtGate(msg({ chatType: "group", text: "just chatting" }), "MeshBot")).toBe(false);
});

test("passesAtGate trusts the scope contract when botName is empty", () => {
  expect(passesAtGate(msg({ chatType: "group", text: "no mention here" }), "")).toBe(true);
});

test("stripBotMention removes a leading @bot from group text only", () => {
  expect(stripBotMention(msg({ chatType: "group", text: "@MeshBot hello there" }), "MeshBot")).toBe("hello there");
  expect(stripBotMention(msg({ chatType: "group", text: "  @MeshBot   spaced" }), "MeshBot")).toBe("spaced");
});

test("stripBotMention leaves p2p text and mid-text mentions intact", () => {
  expect(stripBotMention(msg({ chatType: "p2p", text: "@MeshBot hi" }), "MeshBot")).toBe("@MeshBot hi");
  expect(stripBotMention(msg({ chatType: "group", text: "hey @MeshBot here" }), "MeshBot")).toBe("hey @MeshBot here");
  expect(stripBotMention(msg({ chatType: "group", text: "@MeshBot hi" }), "")).toBe("@MeshBot hi"); // no botName => no-op
});
