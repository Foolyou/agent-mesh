// src/channels/gating.ts
//
// Pure inbound-gating predicates: which Feishu messages are allowed to reach the router, and
// how their text is cleaned. Kept side-effect-free so the dedup/feed loop (FeishuChannel) and
// unit tests share exactly the same decisions.

import type { FeishuChannelConfig, InboundMsg } from "./types";

/** Sender gate: only whitelisted open_ids pass. Empty whitelist => nothing passes. */
export function senderAllowed(cfg: FeishuChannelConfig, senderId: string): boolean {
  return cfg.allowSenders.includes(senderId);
}

/**
 * @-gate.
 *
 * PoC ASSUMPTION (live-verify risk): with only the `im:message.group_at_msg:readonly` scope,
 * Lark delivers group `im.message.receive_v1` events ONLY when the bot is @-mentioned, so any
 * delivered group message is already an @-bot message. The lark-cli projection exposes NO
 * structured `mentions` field, so we do not (and must not) widen scope to fetch one. As
 * defense-in-depth, when a botName is configured we additionally require its rendered mention
 * ("@<botName>", convertlib-resolved) to appear in the group text; an empty botName trusts the
 * scope contract alone. p2p messages always pass.
 */
export function passesAtGate(msg: InboundMsg, botName: string): boolean {
  if (msg.chatType === "p2p") return true;
  if (!botName) return true; // trust the group_at_msg scope delivery contract
  return msg.text.includes("@" + botName);
}

/**
 * Strip a leading rendered "@<botName>" (with optional surrounding whitespace) from group
 * message text. No-op for p2p or when botName is empty. Only the leading mention is removed;
 * mid-text occurrences are left intact.
 */
export function stripBotMention(msg: InboundMsg, botName: string): string {
  if (msg.chatType !== "group" || !botName) return msg.text;
  let t = msg.text.replace(/^\s+/, "");
  const at = "@" + botName;
  if (t.startsWith(at)) t = t.slice(at.length).replace(/^\s+/, "");
  return t;
}
