// src/channels/types.ts
//
// Channel abstraction: bridge an external chat surface (Feishu/Lark for this PoC) to ONE
// mesh's router. One external conversation is HARD-BOUND to one mesh — inbound user text is
// fed to the router via MeshManager.promptRouter, and the router's outbound message chunks are
// mirrored back to the bound conversation. A channel hangs off the backend main process (next
// to buildGateway/reapOnExit in src/main.ts), never a per-mesh host daemon. It only ever READS
// the mesh control plane (on / promptRouter / routerOf / listMeshes); it never mutates mesh
// definitions or control-plane state.

import type { MeshEvent } from "../acp/types";

/** A startable/stoppable external bridge. stop() must leave no orphaned subprocess. */
export interface Channel {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

/** The narrow, READ-ONLY slice of MeshManager a channel depends on. Keeping it structural
 *  (MeshManager satisfies it as-is) lets the relay be unit-tested with a fake and keeps the
 *  channel from reaching into mutating APIs. */
export interface MeshGateway {
  on(listener: (name: string, e: MeshEvent) => void): () => void;
  /** Throws when the mesh is not running (used as the "don't auto-start, reply hint" signal). */
  promptRouter(name: string, text: string): Promise<void>;
  routerOf(name: string): string;
  listMeshes(): { name: string; status: string }[];
}

/** A parsed inbound Feishu message — projection of lark-cli `im.message.receive_v1` NDJSON.
 *  Note: the lark-cli projection carries NO structured `mentions` field; `.content` is
 *  convertlib-prerendered plain text with @-mentions resolved to display names. */
export interface InboundMsg {
  eventId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string; // open_id
  messageType: string; // text / post / image / ...
  text: string;
}

/** Resolved Feishu channel config (from `<root>/channels/feishu.json`; user-owned runtime
 *  data, NEVER created or committed by this code). */
export interface FeishuChannelConfig {
  enabled: boolean;
  /** Target mesh name. PoC recommends a dedicated `feishu-poc`, not the live working mesh. */
  mesh: string;
  /** The single bound conversation; ALL outbound goes here (no multi-chat routing). */
  chatId: string;
  /** Bot display name, used to strip a leading rendered "@<botName> " from group messages. */
  botName: string;
  /** open_id whitelist; only the user themself for the PoC. Empty => nothing passes. */
  allowSenders: string[];
  outbound: { minIntervalMs: number };
}
