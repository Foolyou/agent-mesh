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
import { CardSender, sdkCardCreate, sdkCardSend, sdkCardContent, sdkCardFinalize, sdkCardElementUpdate, type CardSenderOptions } from "./card-sender";
import { createImageResolver, readArtifactImage, sdkUploadImage, consoleViewerUrl, jimpScaler } from "./card-image";
import { FeishuChannelController } from "./controller";

/** Context for resolving `artifact:` images on a bound mesh chat (C3). p2p chats omit it. */
export interface OutboundImageContext {
  root: string;
  mesh: string;
  /** Author agent for a bare `artifact:<file>` ref (the mesh's router). */
  defaultAgent: string;
}

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
  // Router id per mesh, for resolving bare `artifact:<file>` refs to the author's artifact dir (C3).
  const routerOf = (meshName: string): string => {
    try {
      return mesh.routerOf(meshName);
    } catch {
      return ""; // mesh not defined/running → bare artifact: refs degrade gracefully
    }
  };
  const senders = new Map(
    cfg.bindings.map((binding) => [
      binding.chatId,
      createOutboundSender(client, cfg, binding.chatId, log, { root: opts.root, mesh: binding.mesh, defaultAgent: routerOf(binding.mesh) }),
    ]),
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

/** Build the outbound sink for one bound chat. Default path is the CardKit `CardSender` wrapping a text
 *  `LarkSender` as its fallback. Only `outbound.cardkit=false` selects the plain text `LarkSender`;
 *  `streaming=false` still uses the `CardSender` (FeishuChannel routes it to `flush()→sendOneShot()` for
 *  a non-streaming rich one-shot). No client-version probing — CardKit is the advertised default. */
export function createOutboundSender(client: lark.Client, cfg: FeishuChannelConfig, chatId: string, log: (msg: string) => void, image?: OutboundImageContext): OutboundSink {
  const textSender = new LarkSender({
    chatId,
    send: sdkSend(client),
    update: sdkUpdate(client),
    minIntervalMs: cfg.outbound.minIntervalMs,
    streamMinEditIntervalMs: cfg.outbound.streamMinEditIntervalMs,
    maxEditsPerMessage: cfg.outbound.maxEditsPerMessage,
    log,
  });
  // CardKit is the rich path. Build a CardSender whenever cardkit is enabled — INCLUDING when
  // outbound.streaming=false: FeishuChannel.useStreaming() then routes the turn to flush()→sendOneShot
  // (a non-streaming one-shot rich render), so a non-streaming binding still gets markdown + image
  // cards. Only an explicit cardkit=false falls back to the plain text LarkSender.
  if (cfg.outbound.cardkit === false) return textSender;
  return new CardSender(cardSenderOptions(client, cfg, chatId, textSender, log, image));
}

/** Build the CardSender options for a binding. The card path gets the configured timing — the hard
 *  inter-op gap (minIntervalMs) and the per-card edit gap (from outbound.streamMinEditIntervalMs) —
 *  which were previously only wired to the text fallback. Exported so wiring is unit-testable. */
export function cardSenderOptions(client: lark.Client, cfg: FeishuChannelConfig, chatId: string, fallback: OutboundSink, log: (msg: string) => void, image?: OutboundImageContext): CardSenderOptions {
  // C3: on a bound mesh chat, wire artifact-image resolution (B1: in-process direct read) + upload +
  // element swap. Absent (p2p) → the sender keeps the C2 placeholder-only behavior.
  const imageDeps = image
    ? {
        resolveImage: createImageResolver({
          mesh: image.mesh,
          defaultAgent: image.defaultAgent,
          readImage: readArtifactImage(image.root),
          upload: sdkUploadImage(client),
          // jimp-backed autoscale: salvageable oversize images are proportionally downscaled to the
          // Feishu limits instead of degrading (the live 200570 "invalid image keys" / over-dimension fix).
          scaler: jimpScaler(),
          viewerUrl: consoleViewerUrl(process.env.MESH_CONSOLE_URL),
          log,
        }),
        updateElement: sdkCardElementUpdate(client),
      }
    : {};
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
    ...imageDeps,
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
