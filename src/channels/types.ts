// src/channels/types.ts
//
// Channel abstraction: bridge an external chat surface (Feishu/Lark for this PoC) to mesh
// routers. A single Feishu bot may own several mesh<->chat bindings, but the runtime only ever
// has one bot credential set. Inbound user text is routed by chat_id to the matching mesh router,
// and router chunks are mirrored back to that mesh's Feishu group.

import type { MeshEvent, PromptImageRef } from "../acp/types";

/** A startable/stoppable external bridge. stop() must leave no orphaned subprocess. */
export interface Channel {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

/** The narrow, READ-ONLY slice of MeshManager a channel depends on. Keeping it structural
 *  (MeshManager satisfies it as-is) lets the relay be unit-tested with a fake and keeps the
 *  channel from reaching into unrelated control-plane APIs. */
export interface MeshGateway {
  on(listener: (name: string, e: MeshEvent) => void): () => void;
  promptRouter(name: string, text: string, images?: PromptImageRef[]): Promise<void>;
  startMesh(name: string): Promise<void>;
  stopMesh(name: string): Promise<void>;
  newAllSessions(name: string): Promise<void>;
  routerOf(name: string): string;
  listMeshes(): { name: string; status: string }[];
}

export type FeishuDomain = "feishu" | "lark" | string;

/** A parsed inbound Feishu message — projection of SDK `im.message.receive_v1` events.
 *  The text is normalized to plain text with @-mention keys best-effort rendered as names. */
export interface InboundMsg {
  eventId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string; // open_id
  messageType: string; // text / post / image / ...
  text: string;
  mentions: InboundMention[];
  /** Raw Feishu message_id (needed to download message resources like images). */
  messageId: string;
  /** image_key from an `image` message's content, used to download the image resource. */
  imageKey?: string;
}

export interface InboundMention {
  key: string;
  id: string;
  name: string;
}

/** Bytes of a downloaded inbound image resource. mimeType/name are advisory; the upload store
 *  sniffs the real type from the bytes. */
export interface DownloadedImage {
  bytes: Uint8Array;
  name?: string;
  mimeType?: string;
}

/** Download an inbound image resource by (message_id, image_key). Injected so the channel is
 *  unit-tested without the SDK; index.ts wires the real bot-client download. */
export type InboundImageDownloader = (req: { messageId: string; imageKey: string }) => Promise<DownloadedImage>;

/** Resolved Feishu channel config (from `<root>/channels/feishu.json`; user-owned runtime
 *  data). */
export interface FeishuChannelConfig {
  enabled: boolean;
  /** Feishu/Lark app credential. Required only when `enabled=true`. */
  appId: string;
  appSecret: string;
  /** `feishu` (default), `lark`, or a custom SDK domain string. */
  domain: FeishuDomain;
  /** Legacy first binding projection. Prefer `bindings` for new code. */
  mesh: string;
  /** Legacy first binding projection. Prefer `bindings` for new code. */
  chatId: string;
  /** Bot mention id (usually the bot open_id in Feishu mention payloads), preferred for @ gate. */
  botMentionId: string;
  /** Bot display name, fallback for @ gate and used to strip a leading rendered "@<botName> ". */
  botName: string;
  /** Group chats require an @ mention by default. Set false only for explicitly bound chats. */
  requireMention: boolean;
  /** open_id whitelist; only the user themself for the PoC. Empty => nothing passes. */
  allowSenders: string[];
  outbound: {
    minIntervalMs: number;
    /** True streaming: edit ONE message in place as router chunks arrive (default true). */
    streaming?: boolean;
    /** Use CardKit streaming cards as the default outbound path (default true). When false, stream
     *  via in-place text message edits. Ignored when `streaming` is false. */
    cardkit?: boolean;
    /** Minimum gap between in-place edits of the live message (ms). Default 1000. */
    streamMinEditIntervalMs?: number;
    /** Turn-boundary fallback for streaming: if no router `idle` arrives, finalize the current turn
     *  this long after the last chunk so the next turn starts fresh (default 3000, per PrdMgr for this
     *  P0). Tradeoff: a genuine mid-turn pause longer than this splits the one reply across cards
     *  (no loss/concat — a late same-turn chunk just opens a fresh card). Raise it if such pauses are
     *  common; lower it to surface replies sooner when idle is unreliable. */
    streamCommitDebounceMs?: number;
    /** Feishu caps a message at 20 edits; roll over to a fresh message past this. Default 18. */
    maxEditsPerMessage?: number;
    /** How router tool calls are surfaced in the streaming card (de-noising: tool calls render
     *  IN-CARD and never open a new message). `collapsed` (default) = one folded line `🔧 调用了 N 个
     *  工具`; `inline` = list each tool name `🔧 调用工具：A · B · C`; `off` = render nothing (events
     *  are still consumed for dedupe + turn-end finalize). Missing/invalid/old config ⇒ collapsed. */
    toolDisplay?: "collapsed" | "inline" | "off";
  };
  websocket: { handshakeTimeoutMs?: number; pingTimeout?: number };
  /** One Feishu group per mesh. Empty is valid while a bot is bound but groups are not created. */
  bindings: FeishuMeshBinding[];
}

export interface FeishuMeshBinding {
  mesh: string;
  chatId: string;
  name?: string;
  createdAt?: string;
  source?: "manual" | "auto";
  botMentionId?: string;
  botName?: string;
  requireMention?: boolean;
  allowSenders?: string[];
}

export type FeishuChannelState = "disabled" | "running" | "stopped" | "error";

export interface FeishuChannelStatus {
  state: FeishuChannelState;
  configPath: string;
  configured: boolean;
  enabled: boolean;
  mesh?: string;
  chatId?: string;
  appId?: string;
  domain?: FeishuDomain;
  bindings?: FeishuMeshBinding[];
  reason?: string;
  updatedAt: string;
}

export interface FeishuProvisionStartRequest {
  mesh?: string;
  chatId?: string;
  botMentionId?: string;
  botName?: string;
  requireMention?: boolean;
  allowSenders?: string[];
  enable?: boolean;
  appName?: string;
  appDescription?: string;
  createOnly?: boolean;
  appId?: string;
  autoCreateMeshChats?: boolean;
  replaceExisting?: boolean;
}

export type FeishuProvisionJobState = "starting" | "waiting" | "complete" | "error" | "cancelled";

export interface FeishuProvisionJobPublic {
  id: string;
  state: FeishuProvisionJobState;
  createdAt: string;
  updatedAt: string;
  verificationUrl?: string;
  qrCodeDataUrl?: string;
  expireIn?: number;
  appId?: string;
  tenantBrand?: "feishu" | "lark";
  openId?: string;
  error?: string;
  configPath?: string;
}

export interface FeishuMeshChatEnsureResult {
  mesh: string;
  chatId?: string;
  name?: string;
  created?: boolean;
  ok: boolean;
  error?: string;
}

export interface FeishuChannelControl {
  status(): FeishuChannelStatus;
  reload(): Promise<FeishuChannelStatus>;
  startProvision(input?: FeishuProvisionStartRequest): Promise<FeishuProvisionJobPublic>;
  getProvision(id: string): FeishuProvisionJobPublic | undefined;
  cancelProvision(id: string): FeishuProvisionJobPublic | undefined;
  ensureMeshChat(mesh: string): Promise<FeishuMeshChatEnsureResult>;
  syncMeshChats(): Promise<FeishuMeshChatEnsureResult[]>;
}
