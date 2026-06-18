// src/channels/index.ts
//
// Factory entry point used by the backend main process (src/main.ts). Returns a started-able
// Channel when `<root>/channels/feishu.json` is present + enabled, or undefined otherwise (the
// caller then leaves the channel off). Wires the REAL lark-cli consumer + sender; the relay
// logic lives in FeishuChannel. NOT yet referenced by main.ts — that wiring is the final commit.

import type { Channel, MeshGateway } from "./types";
import { loadFeishuConfig } from "./config";
import { FeishuChannel } from "./feishu-channel";
import { LarkConsumer } from "./consumer";
import { LarkSender } from "./sender";
import { realSpawnConsumer, realSend } from "./process";

export interface BuildFeishuChannelOpts {
  root: string;
  log?: (msg: string) => void;
}

/** Build the Feishu channel for a backend, or undefined when not configured/enabled. */
export function buildFeishuChannel(mesh: MeshGateway, opts: BuildFeishuChannelOpts): Channel | undefined {
  const log = opts.log ?? ((m) => console.log(m));
  const cfg = loadFeishuConfig(opts.root, log);
  if (!cfg) return undefined;
  const sender = new LarkSender({ chatId: cfg.chatId, send: realSend(), minIntervalMs: cfg.outbound.minIntervalMs, log });
  return new FeishuChannel({
    mesh,
    config: cfg,
    sender,
    log,
    makeConsumer: (onMessage) => new LarkConsumer({ onMessage, spawn: realSpawnConsumer(), log }),
  });
}

export { loadFeishuConfig, feishuConfigPath, normalizeFeishuConfig } from "./config";
export { senderAllowed, passesAtGate, stripBotMention } from "./gating";
export type { Channel, MeshGateway, InboundMsg, FeishuChannelConfig } from "./types";
