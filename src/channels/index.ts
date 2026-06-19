// src/channels/index.ts
//
// Factory entry points used by the backend main process (src/main.ts). The direct builder creates
// one started-able Feishu Channel from the current config; the controller wraps it with runtime
// reload/watch/provisioning support. The relay logic lives in FeishuChannel; transport is the
// official Feishu/Lark Node SDK.

import type { Channel, MeshGateway } from "./types";
import { loadFeishuConfig } from "./config";
import { FeishuChannel } from "./feishu-channel";
import { createFeishuClient, LarkConsumer } from "./consumer";
import { LarkSender, sdkSend, sdkUpdate } from "./sender";
import { FeishuChannelController } from "./controller";

export interface BuildFeishuChannelOpts {
  root: string;
  log?: (msg: string) => void;
}

/** Build the Feishu channel for a backend, or undefined when not configured/enabled. */
export function buildFeishuChannel(mesh: MeshGateway, opts: BuildFeishuChannelOpts): Channel | undefined {
  const log = opts.log ?? ((m) => console.log(m));
  const cfg = loadFeishuConfig(opts.root, log);
  if (!cfg) return undefined;
  const client = createFeishuClient(cfg);
  const send = sdkSend(client);
  const update = sdkUpdate(client);
  const senders = new Map(
    cfg.bindings.map((binding) => [
      binding.chatId,
      new LarkSender({
        chatId: binding.chatId,
        send,
        update,
        minIntervalMs: cfg.outbound.minIntervalMs,
        streamMinEditIntervalMs: cfg.outbound.streamMinEditIntervalMs,
        maxEditsPerMessage: cfg.outbound.maxEditsPerMessage,
        log,
      }),
    ]),
  );
  return new FeishuChannel({
    mesh,
    config: cfg,
    senders,
    log,
    makeConsumer: (onMessage) =>
      new LarkConsumer({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        domain: cfg.domain,
        handshakeTimeoutMs: cfg.websocket.handshakeTimeoutMs,
        pingTimeout: cfg.websocket.pingTimeout,
        onMessage,
        log,
      }),
  });
}

export function createFeishuChannelController(mesh: MeshGateway, opts: BuildFeishuChannelOpts): FeishuChannelController {
  return new FeishuChannelController(mesh, { ...opts, buildChannel: buildFeishuChannel });
}

export { loadFeishuConfig, feishuConfigPath, normalizeFeishuConfig, readFeishuConfig } from "./config";
export { senderAllowed, passesAtGate, stripBotMention } from "./gating";
export type {
  Channel,
  MeshGateway,
  InboundMsg,
  InboundMention,
  FeishuChannelConfig,
  FeishuChannelControl,
  FeishuChannelStatus,
  FeishuMeshBinding,
  FeishuMeshChatEnsureResult,
  FeishuProvisionJobPublic,
  FeishuProvisionStartRequest,
} from "./types";
