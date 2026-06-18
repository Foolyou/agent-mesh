// src/channels/index.ts
//
// Factory entry point used by the backend main process (src/main.ts). Returns a started-able
// Channel when `<root>/channels/feishu.json` is present + enabled, or undefined otherwise (the
// caller then leaves the channel off). NOT YET WIRED into main.ts — the inbound consumer and
// outbound relay are assembled in the following commits; this commit only validates config +
// gating so the wiring change stays small later.

import type { Channel, MeshGateway } from "./types";
import { loadFeishuConfig } from "./config";

export interface BuildFeishuChannelOpts {
  root: string;
  log?: (msg: string) => void;
}

/** Build the Feishu channel for a backend, or undefined when not configured/enabled. */
export function buildFeishuChannel(mesh: MeshGateway, opts: BuildFeishuChannelOpts): Channel | undefined {
  const log = opts.log ?? ((m) => console.log(m));
  const cfg = loadFeishuConfig(opts.root, log);
  if (!cfg) return undefined;
  // Inbound consumer + outbound relay land in the next commits. Until then start()/stop() are
  // inert, so an early wire-in is safe but performs no I/O.
  void mesh;
  return {
    start() {
      log(`feishu channel: configured for mesh "${cfg.mesh}" → chat ${cfg.chatId} (consumer/relay pending)`);
    },
    stop() {},
  };
}

export { loadFeishuConfig, feishuConfigPath, normalizeFeishuConfig } from "./config";
export { senderAllowed, passesAtGate, stripBotMention } from "./gating";
export type { Channel, MeshGateway, InboundMsg, FeishuChannelConfig } from "./types";
