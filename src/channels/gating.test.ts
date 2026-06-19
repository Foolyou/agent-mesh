import { test, expect } from "bun:test";
import { applyAllowSeed, feishuChannelKey, senderAllowed, senderAuthorized, passesAtGate, stripBotMention } from "./gating";
import { emptyFeishuAuth, feishuAllowKey, type FeishuAuthFile } from "../auth-store";
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
  return { eventId: "e1", chatId: "oc_1", chatType: "p2p", senderId: "ou_me", messageType: "text", text: "hi", mentions: [], messageId: "om_1", ...over };
}

test("senderAllowed only passes whitelisted open_ids", () => {
  expect(senderAllowed(cfg(), "ou_me")).toBe(true);
  expect(senderAllowed(cfg(), "ou_stranger")).toBe(false);
  expect(senderAllowed(cfg({ allowSenders: [] }), "ou_me")).toBe(false); // empty => nothing passes
});

// ── dynamic auth gate (design §1.4 / §5.2) ───────────────────────────────────

test("feishuChannelKey is 'feishu:' + appId", () => {
  expect(feishuChannelKey("cli_abc")).toBe("feishu:cli_abc");
});

function approvedSnapshot(channelKey: string, openId: string): FeishuAuthFile {
  const f = emptyFeishuAuth();
  f.allow[feishuAllowKey(channelKey, openId)] = { channelKey, openId, status: "approved", approvedAt: "2026-06-20T00:00:00.000Z" };
  return f;
}

test("senderAuthorized fails closed without a snapshot", () => {
  expect(senderAuthorized(undefined, "feishu:cli_1", "ou_me")).toBe(false);
  expect(senderAuthorized(emptyFeishuAuth(), "feishu:cli_1", "ou_me")).toBe(false); // empty registry => deny
});

test("senderAuthorized passes only an approved (channelKey, openId)", () => {
  const snap = approvedSnapshot("feishu:cli_1", "ou_me");
  expect(senderAuthorized(snap, "feishu:cli_1", "ou_me")).toBe(true);
  expect(senderAuthorized(snap, "feishu:cli_1", "ou_other")).toBe(false); // same channel, different open id
  expect(senderAuthorized(snap, "feishu:cli_2", "ou_me")).toBe(false); // same open id, different app/channel
});

test("senderAuthorized denies a revoked entry", () => {
  const snap = approvedSnapshot("feishu:cli_1", "ou_me");
  snap.allow[feishuAllowKey("feishu:cli_1", "ou_me")].status = "revoked";
  expect(senderAuthorized(snap, "feishu:cli_1", "ou_me")).toBe(false);
});

test("applyAllowSeed adds absent entries as approved and is idempotent", () => {
  const f = emptyFeishuAuth();
  expect(applyAllowSeed(f, "feishu:cli_1", ["ou_a", "ou_b", ""], "2026-06-20T00:00:00.000Z")).toBe(true);
  expect(Object.keys(f.allow)).toHaveLength(2); // blank open id skipped
  expect(f.allow[feishuAllowKey("feishu:cli_1", "ou_a")].status).toBe("approved");
  // second pass adds nothing
  expect(applyAllowSeed(f, "feishu:cli_1", ["ou_a", "ou_b"], "2026-06-20T01:00:00.000Z")).toBe(false);
});

test("applyAllowSeed never overrides an existing entry (preserves a CLI revoke)", () => {
  const f = approvedSnapshot("feishu:cli_1", "ou_me");
  f.allow[feishuAllowKey("feishu:cli_1", "ou_me")].status = "revoked";
  expect(applyAllowSeed(f, "feishu:cli_1", ["ou_me"], "2026-06-20T02:00:00.000Z")).toBe(false); // not re-approved
  expect(f.allow[feishuAllowKey("feishu:cli_1", "ou_me")].status).toBe("revoked");
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
