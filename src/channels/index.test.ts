import { test, expect } from "bun:test";
import { createOutboundSender, cardSenderOptions } from "./index";
import { createFeishuClient } from "./consumer";
import { CardSender } from "./card-sender";
import { LarkSender } from "./sender";
import type { OutboundSink } from "./feishu-channel";
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

test("streaming=false + cardkit=true still wires a CardSender (non-streaming rich one-shot via sendOneShot)", () => {
  const sink = createOutboundSender(client, cfg({ streaming: false, cardkit: true }), "oc_1", () => {});
  expect(sink).toBeInstanceOf(CardSender);
  expect(typeof sink.sendOneShot).toBe("function"); // the channel routes flush()→sendOneShot for non-streaming
});

test("cardkit=false wires the plain text LarkSender even when streaming is on", () => {
  const sink = createOutboundSender(client, cfg({ streaming: true, cardkit: false }), "oc_1", () => {});
  expect(sink).toBeInstanceOf(LarkSender);
});

test("cardSenderOptions passes the configured timing through to the CardSender", () => {
  const fallback: OutboundSink = { enqueue() {}, stop() {} };
  const opts = cardSenderOptions(client, cfg({ minIntervalMs: 5, streamMinEditIntervalMs: 7 }), "oc_1", fallback, () => {});
  expect(opts.minIntervalMs).toBe(5); // hard inter-op gap
  expect(opts.minEditIntervalMs).toBe(7); // per-card edit gap (from outbound.streamMinEditIntervalMs)
  expect(opts.fallback).toBe(fallback);
  expect(typeof opts.create).toBe("function");
  expect(typeof opts.finalize).toBe("function");
});
