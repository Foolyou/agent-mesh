// src/channels/index.ts
//
// Factory entry points used by the backend main process (src/main.ts). The direct builder creates
// one started-able Feishu Channel from the current config; the controller wraps it with runtime
// reload/watch/provisioning support. The relay logic lives in FeishuChannel; transport is the
// official Feishu/Lark Node SDK.

import * as lark from "@larksuiteoapi/node-sdk";
import type { Channel, FeishuChannelConfig, MeshGateway } from "./types";
import type { OutboundSink } from "./feishu-channel";
import type { AssistantGateway } from "./assistant-gateway";
import { loadFeishuConfig } from "./config";
import { FeishuChannel } from "./feishu-channel";
import { createFeishuClient, LarkConsumer, sdkDownloadImage } from "./consumer";
import { LarkSender, sdkSend, sdkUpdate } from "./sender";
import { CardSender, sdkCardCreate, sdkCardSend, sdkCardContent, sdkCardFinalize, type CardSenderOptions } from "./card-sender";
import { FeishuChannelController } from "./controller";

export interface BuildFeishuChannelOpts {
  root: string;
  log?: (msg: string) => void;
  /** Gateway to the central Mesh Assistant for authorized p2p DMs (device-auth Phase 5). */
  assistant?: AssistantGateway;
}

/** Build the Feishu channel for a backend, or undefined when not configured/enabled. */
export function buildFeishuChannel(mesh: MeshGateway, opts: BuildFeishuChannelOpts): Channel | undefined {
  const log = opts.log ?? ((m) => console.log(m));
  const cfg = loadFeishuConfig(opts.root, log);
  if (!cfg) return undefined;
  const client = createFeishuClient(cfg);
  const senders = new Map(
    cfg.bindings.map((binding) => [binding.chatId, createOutboundSender(client, cfg, binding.chatId, log)]),
  );
  return new FeishuChannel({
    mesh,
    config: cfg,
    senders,
    log,
    root: opts.root,
    assistant: opts.assistant,
    // p2p DMs have no preconfigured sender: make one on demand for the user's p2p chat (same CardKit
    // streaming sender as bound chats), so the assistant reply reuses the existing outbound machinery.
    makeSender: (chatId) => createOutboundSender(client, cfg, chatId, log),
    downloadImage: sdkDownloadImage(client),
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

/** Build the outbound sink for one bound chat. Default path is the CardKit streaming `CardSender`
 *  wrapping a text `LarkSender` as its fallback; `outbound.cardkit=false` (or `streaming=false`)
 *  selects the plain text sender. No client-version probing — CardKit is the advertised default. */
export function createOutboundSender(client: lark.Client, cfg: FeishuChannelConfig, chatId: string, log: (msg: string) => void): OutboundSink {
  const textSender = new LarkSender({
    chatId,
    send: sdkSend(client),
    update: sdkUpdate(client),
    minIntervalMs: cfg.outbound.minIntervalMs,
    streamMinEditIntervalMs: cfg.outbound.streamMinEditIntervalMs,
    maxEditsPerMessage: cfg.outbound.maxEditsPerMessage,
    log,
  });
  const streamingOn = cfg.outbound.streaming !== false;
  const cardkitOn = cfg.outbound.cardkit !== false;
  if (!streamingOn || !cardkitOn) return textSender;
  return new CardSender(cardSenderOptions(client, cfg, chatId, textSender, log));
}

/** Build the CardSender options for a binding. The card path gets the configured timing — the hard
 *  inter-op gap (minIntervalMs) and the per-card edit gap (from outbound.streamMinEditIntervalMs) —
 *  which were previously only wired to the text fallback. Exported so wiring is unit-testable. */
export function cardSenderOptions(client: lark.Client, cfg: FeishuChannelConfig, chatId: string, fallback: OutboundSink, log: (msg: string) => void): CardSenderOptions {
  return {
    chatId,
    create: sdkCardCreate(client),
    send: sdkCardSend(client),
    content: sdkCardContent(client),
    finalize: sdkCardFinalize(client),
    fallback,
    minIntervalMs: cfg.outbound.minIntervalMs,
    minEditIntervalMs: cfg.outbound.streamMinEditIntervalMs,
    log,
  };
}

export function createFeishuChannelController(mesh: MeshGateway, opts: BuildFeishuChannelOpts): FeishuChannelController {
  return new FeishuChannelController(mesh, { ...opts, buildChannel: buildFeishuChannel });
}

export { loadFeishuConfig, feishuConfigPath, normalizeFeishuConfig, readFeishuConfig } from "./config";
export { senderAllowed, passesAtGate, stripBotMention } from "./gating";
export { unavailableAssistantGateway } from "./assistant-gateway";
export type { AssistantGateway } from "./assistant-gateway";
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
