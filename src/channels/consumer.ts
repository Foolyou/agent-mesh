// src/channels/consumer.ts
//
// Inbound side: uses the official Feishu/Lark Node SDK long-connection client
// (`WSClient` + `EventDispatcher`) to consume `im.message.receive_v1` events. This replaces the
// previous subprocess supervisor; no child process is spawned and reconnect/liveness are
// delegated to the SDK.

import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuDomain, InboundMention, InboundMsg } from "./types";

type ReceiveHandler = NonNullable<lark.EventHandles["im.message.receive_v1"]>;
export type ReceiveEvent = Parameters<ReceiveHandler>[0];
type EventDispatcher = InstanceType<typeof lark.EventDispatcher>;

export interface FeishuWsClient {
  start(params: { eventDispatcher: EventDispatcher }): Promise<void>;
  close(params?: { force?: boolean }): void;
  getConnectionStatus?(): unknown;
}

export interface LarkConsumerOptions {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
  onMessage: (msg: InboundMsg) => void;
  log?: (msg: string) => void;
  handshakeTimeoutMs?: number;
  pingTimeout?: number;
  createWsClient?: (params: {
    appId: string;
    appSecret: string;
    domain: FeishuDomain;
    handshakeTimeoutMs?: number;
    pingTimeout?: number;
    log: (msg: string) => void;
  }) => FeishuWsClient;
}

export class LarkConsumer {
  private readonly opts: LarkConsumerOptions;
  private readonly log: (msg: string) => void;
  private ws?: FeishuWsClient;
  private started = false;

  constructor(opts: LarkConsumerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
      "im.message.receive_v1": async (data) => {
        const msg = parseInboundEvent(data);
        if (msg) this.opts.onMessage(msg);
      },
    });
    const ws = this.opts.createWsClient
      ? this.opts.createWsClient({
          appId: this.opts.appId,
          appSecret: this.opts.appSecret,
          domain: this.opts.domain ?? "feishu",
          handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
          pingTimeout: this.opts.pingTimeout,
          log: this.log,
        })
      : createRealWsClient({
          appId: this.opts.appId,
          appSecret: this.opts.appSecret,
          domain: this.opts.domain ?? "feishu",
          handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
          pingTimeout: this.opts.pingTimeout,
          log: this.log,
        });
    this.ws = ws;
    await ws.start({ eventDispatcher: dispatcher });
    this.log("feishu consumer: SDK websocket started");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.ws?.close({ force: false });
    this.ws = undefined;
  }
}

export function parseInboundEvent(data: ReceiveEvent): InboundMsg | undefined {
  const eventId = str(data.event_id) || str(data.uuid) || str(data.message?.message_id);
  const chatId = str(data.message?.chat_id);
  const senderId = str(data.sender?.sender_id?.open_id);
  const chatType = data.message?.chat_type === "group" ? "group" : data.message?.chat_type === "p2p" ? "p2p" : undefined;
  if (!eventId || !chatId || !senderId || !chatType) return undefined;
  const messageType = str(data.message?.message_type) || "text";
  return {
    eventId,
    chatId,
    chatType,
    senderId,
    messageType,
    text: textFromContent(str(data.message?.content), data.message?.mentions),
    mentions: mentionsFrom(data.message?.mentions),
  };
}

export function textFromContent(content: string, mentions?: ReceiveEvent["message"]["mentions"]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return renderMentions(content, mentions);
  }
  const text = parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string"
    ? (parsed as { text: string }).text
    : content;
  return renderMentions(text, mentions);
}

function renderMentions(text: string, mentions?: ReceiveEvent["message"]["mentions"]): string {
  let out = text;
  for (const m of mentions ?? []) {
    const key = str(m.key);
    const name = str(m.name);
    if (!key || !name) continue;
    const rendered = `@${name}`;
    out = out.split(`@${key}`).join(rendered);
    out = out.split(key).join(rendered);
  }
  return out;
}

function mentionsFrom(mentions?: ReceiveEvent["message"]["mentions"]): InboundMention[] {
  return (mentions ?? [])
    .map((m) => ({
      key: str((m as any).key),
      id: mentionId((m as any).id),
      name: str((m as any).name),
    }))
    .filter((m) => m.key || m.id || m.name);
}

export function createFeishuClient(cfg: { appId: string; appSecret: string; domain?: FeishuDomain }): lark.Client {
  return new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: sdkDomain(cfg.domain ?? "feishu"),
  });
}

function createRealWsClient(params: {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  handshakeTimeoutMs?: number;
  pingTimeout?: number;
  log: (msg: string) => void;
}): FeishuWsClient {
  return new lark.WSClient({
    appId: params.appId,
    appSecret: params.appSecret,
    domain: sdkDomain(params.domain),
    source: "agent-mesh",
    loggerLevel: lark.LoggerLevel.info,
    handshakeTimeoutMs: params.handshakeTimeoutMs,
    wsConfig: params.pingTimeout ? { pingTimeout: params.pingTimeout } : undefined,
    onReady: () => params.log("feishu consumer: SDK websocket ready"),
    onError: (e) => params.log(`feishu consumer: SDK websocket error: ${String(e)}`),
    onReconnecting: () => params.log("feishu consumer: SDK websocket reconnecting"),
    onReconnected: () => params.log("feishu consumer: SDK websocket reconnected"),
  });
}

function sdkDomain(domain: FeishuDomain): lark.Domain | string {
  if (domain === "feishu") return lark.Domain.Feishu;
  if (domain === "lark") return lark.Domain.Lark;
  return domain;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function mentionId(v: unknown): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  return str(o.open_id) || str(o.user_id) || str(o.union_id) || str(o.app_id) || str(o.id);
}
