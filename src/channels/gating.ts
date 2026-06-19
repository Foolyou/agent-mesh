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
 * Group chats require an @ mention by default. A trusted, hard-bound chat can opt out with
 * `requireMention=false`, but Feishu still must grant and deliver all group-message events.
 * Prefer the structured mention id because display names are editable; keep botName as a
 * compatibility fallback. Empty id+name trusts the delivery contract alone. p2p messages always
 * pass.
 */
export function passesAtGate(msg: InboundMsg, cfg: FeishuChannelConfig): boolean {
  if (msg.chatType === "p2p") return true;
  if (!cfg.requireMention) return true;
  if (cfg.botMentionId) return msg.mentions.some((m) => m.id === cfg.botMentionId);
  if (!cfg.botName) return true; // trust the group_at_msg scope delivery contract
  return msg.text.includes("@" + cfg.botName);
}

/**
 * Strip a leading rendered bot mention (with optional surrounding whitespace) from group message
 * text. When `botMentionId` is configured, the matching mention's current display name is used;
 * `botName` remains a fallback. Only the leading mention is removed; mid-text occurrences remain.
 */
export function stripBotMention(msg: InboundMsg, cfg: FeishuChannelConfig): string {
  if (msg.chatType !== "group") return msg.text;
  const names = botMentionNames(msg, cfg);
  if (!names.length) return msg.text;
  let t = msg.text.replace(/^\s+/, "");
  for (const name of names) {
    const at = "@" + name;
    if (t.startsWith(at)) {
      t = t.slice(at.length).replace(/^\s+/, "");
      break;
    }
  }
  return t;
}

function botMentionNames(msg: InboundMsg, cfg: FeishuChannelConfig): string[] {
  const names = new Set<string>();
  if (cfg.botMentionId) {
    for (const m of msg.mentions) {
      if (m.id === cfg.botMentionId && m.name) names.add(m.name);
    }
  }
  if (cfg.botName) names.add(cfg.botName);
  return [...names];
}
