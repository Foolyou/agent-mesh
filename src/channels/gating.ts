// src/channels/gating.ts
//
// Pure inbound-gating predicates: which Feishu messages are allowed to reach the router, and
// how their text is cleaned. Kept side-effect-free so the dedup/feed loop (FeishuChannel) and
// unit tests share exactly the same decisions.

import type { FeishuChannelConfig, InboundMsg } from "./types";
import { feishuAllowKey, isFeishuAllowed, type FeishuAuthFile } from "../auth-store";

/** Sender gate: only whitelisted open_ids pass. Empty whitelist => nothing passes.
 *  LEGACY: `allowSenders` is no longer the live gate (see {@link senderAuthorized}); this remains
 *  only as the seed source and for back-compat callers. */
export function senderAllowed(cfg: FeishuChannelConfig, senderId: string): boolean {
  return cfg.allowSenders.includes(senderId);
}

/** The auth-registry channel key for a Feishu app: `"feishu:" + appId` (design §1.4). A single bot
 *  has one app credential, so every binding under it shares this channelKey; the auth unit is
 *  `(channelKey, openId)`. */
export function feishuChannelKey(appId: string): string {
  return `feishu:${appId}`;
}

/** Dynamic sender gate (design §1.4 / §5.2): authorized iff the in-memory auth-registry SNAPSHOT has
 *  `(channelKey, openId)` approved. FAIL CLOSED — a missing snapshot (not loaded yet / load failed) or
 *  any non-approved status denies. Pure + synchronous so the inbound hot path never reads a file. */
export function senderAuthorized(snapshot: FeishuAuthFile | undefined, channelKey: string, openId: string): boolean {
  if (!snapshot) return false;
  return isFeishuAllowed(snapshot, channelKey, openId);
}

/** Seed approved `(channelKey, openId)` entries from config `allowSenders` into a registry file.
 *  Idempotent + migration-safe: only ADDS entries that are absent; it never overwrites an existing
 *  entry, so a prior CLI **revoke** (or approve) is preserved and a seeded user is not re-approved.
 *  Mutates `file` and returns true iff anything was added. */
export function applyAllowSeed(file: FeishuAuthFile, channelKey: string, openIds: Iterable<string>, nowIso: string): boolean {
  let changed = false;
  for (const openId of openIds) {
    if (!openId) continue;
    const key = feishuAllowKey(channelKey, openId);
    if (!file.allow[key]) {
      file.allow[key] = { channelKey, openId, status: "approved", approvedAt: nowIso, note: "seeded from allowSenders" };
      changed = true;
    }
  }
  return changed;
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
