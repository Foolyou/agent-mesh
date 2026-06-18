// src/channels/config.ts
//
// Loads the Feishu channel config from `<root>/channels/feishu.json`. This file is user-owned
// runtime data (real chat_id / open_id / bot identity) — this code ONLY reads it, NEVER creates
// it and NEVER ships an example with secrets. When the file is absent, unreadable, malformed,
// or `enabled` is not true, the channel stays unstarted and the reason is logged.
//
// Expected shape (all strings, no secrets in this repo):
//   {
//     "enabled": true,
//     "mesh": "feishu-poc",
//     "chatId": "oc_xxx",                 // the single bound conversation
//     "botName": "MeshBot",               // used to strip "@MeshBot " from group messages
//     "allowSenders": ["ou_xxx"],         // your own open_id only, for the PoC
//     "outbound": { "minIntervalMs": 500 }
//   }

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { FeishuChannelConfig } from "./types";

export const FEISHU_CONFIG_REL = join("channels", "feishu.json");

/** Resolve the Feishu channel config path under a data root. */
export function feishuConfigPath(root: string): string {
  return join(root, FEISHU_CONFIG_REL);
}

/** Validate + fill defaults on a parsed JSON object. Exported for unit tests (no filesystem).
 *  Returns undefined when required fields (`mesh`, `chatId`) are missing/empty. `enabled` is
 *  carried through verbatim so callers can distinguish "configured but off" from "invalid". */
export function normalizeFeishuConfig(parsed: unknown): FeishuChannelConfig | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const p = parsed as Record<string, unknown>;
  const mesh = strOrEmpty(p.mesh);
  const chatId = strOrEmpty(p.chatId);
  if (!mesh || !chatId) return undefined;
  const botName = strOrEmpty(p.botName);
  const allowSenders = Array.isArray(p.allowSenders)
    ? p.allowSenders.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  const out = (p.outbound ?? {}) as Record<string, unknown>;
  const minIntervalMs = typeof out.minIntervalMs === "number" && Number.isFinite(out.minIntervalMs) && out.minIntervalMs >= 0
    ? out.minIntervalMs
    : 500;
  return { enabled: p.enabled === true, mesh, chatId, botName, allowSenders, outbound: { minIntervalMs } };
}

/** Load + validate config from `<root>/channels/feishu.json`. Returns undefined (channel
 *  disabled) for: missing file, read/parse error, missing required fields, or enabled!==true. */
export function loadFeishuConfig(root: string, log: (msg: string) => void = () => {}): FeishuChannelConfig | undefined {
  const path = feishuConfigPath(root);
  if (!existsSync(path)) {
    log(`feishu channel: no config at ${path}; channel disabled`);
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    log(`feishu channel: cannot read ${path}: ${String(e)}; channel disabled`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log(`feishu channel: invalid JSON in ${path}: ${String(e)}; channel disabled`);
    return undefined;
  }
  const cfg = normalizeFeishuConfig(parsed);
  if (!cfg) {
    log(`feishu channel: ${path} is missing required fields (mesh, chatId); channel disabled`);
    return undefined;
  }
  if (!cfg.enabled) {
    log(`feishu channel: config present but enabled=false; channel disabled`);
    return undefined;
  }
  return cfg;
}

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
