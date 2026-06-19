import { test, expect } from "bun:test";
import { createOutboundSender } from "./index";
import { createFeishuClient } from "./consumer";
import { CardSender } from "./card-sender";
import { LarkSender } from "./sender";
import type { FeishuChannelConfig } from "./types";

function cfg(outbound: Partial<FeishuChannelConfig["outbound"]> = {}): FeishuChannelConfig {
  return {
    enabled: true,
    appId: "cli_x",
    appSecret: "s",
    domain: "feishu",
    mesh: "m",
    chatId: "oc_1",
    botMentionId: "",
    botName: "",
    requireMention: true,
    allowSenders: [],
    outbound: { minIntervalMs: 500, streaming: true, cardkit: true, ...outbound },
    websocket: {},
    bindings: [{ mesh: "m", chatId: "oc_1" }],
  };
}

const client = createFeishuClient({ appId: "cli_x", appSecret: "s" });

test("default config wires a CardKit CardSender (with a text fallback)", () => {
  const sink = createOutboundSender(client, cfg(), "oc_1", () => {});
  expect(sink).toBeInstanceOf(CardSender);
});

test("outbound.cardkit=false wires the plain text LarkSender", () => {
  const sink = createOutboundSender(client, cfg({ cardkit: false }), "oc_1", () => {});
  expect(sink).toBeInstanceOf(LarkSender);
});

test("streaming=false uses the text sender regardless of cardkit", () => {
  const sink = createOutboundSender(client, cfg({ streaming: false, cardkit: true }), "oc_1", () => {});
  expect(sink).toBeInstanceOf(LarkSender);
});
