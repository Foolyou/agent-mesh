// src/channels/config.ts
//
// Loads the Feishu channel config from `<root>/channels/feishu.json`. This file is user-owned
// runtime data (app credentials / real chat_id / open_id / bot identity). When the file is
// absent, disabled, incomplete, unreadable, or malformed, the channel stays unstarted and the
// reason is logged/statused. The provisioning API may create/update this file at runtime.
//
// Expected shape (all strings, no secrets in this repo):
//   {
//     "enabled": true,
//     "appId": "cli_xxx",
//     "appSecret": "xxx",
//     "domain": "feishu",
//     "bindings": [
//       { "mesh": "feishu-poc", "chatId": "oc_xxx", "name": "feishu-poc@my-host" }
//     ],
//     "botMentionId": "ou_xxx",           // preferred @ gate for group messages
//     "botName": "MeshBot",               // fallback @ gate / leading mention strip
//     "requireMention": true,             // set false only for trusted bound groups
//     "allowSenders": ["ou_xxx"],         // your own open_id only, for the PoC
//     "outbound": { "minIntervalMs": 500 }
//   }

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { FeishuChannelConfig, FeishuDomain, FeishuMeshBinding } from "./types";

export const FEISHU_CONFIG_REL = join("channels", "feishu.json");

/** Resolve the Feishu channel config path under a data root. */
export function feishuConfigPath(root: string): string {
  return join(root, FEISHU_CONFIG_REL);
}

export interface FeishuConfigLoadResult {
  path: string;
  exists: boolean;
  configured: boolean;
  enabled: boolean;
  config?: FeishuChannelConfig;
  reason?: string;
}

/** Validate + fill defaults on a parsed JSON object. Exported for unit tests (no filesystem).
 *  Returns undefined when required bot fields are missing/empty. `enabled` is carried through
 *  when present in the returned config. Mesh bindings may be empty while a bot is newly bound. */
export function normalizeFeishuConfig(parsed: unknown): FeishuChannelConfig | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const p = parsed as Record<string, unknown>;
  const appId = strOrEmpty(p.appId) || strOrEmpty(p.app_id);
  const appSecret = strOrEmpty(p.appSecret) || strOrEmpty(p.app_secret);
  if (!appId || !appSecret) return undefined;
  const domain = normalizeDomain(p.domain);
  const botMentionId = strOrEmpty(p.botMentionId) || strOrEmpty(p.botOpenId) || strOrEmpty(p.botId);
  const botName = strOrEmpty(p.botName);
  const requireMention = p.requireMention === false ? false : true;
  const allowSenders = Array.isArray(p.allowSenders)
    ? p.allowSenders.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  const bindings = normalizeBindings(p, { botMentionId, botName, requireMention, allowSenders });
  const first = bindings[0];
  const out = (p.outbound ?? {}) as Record<string, unknown>;
  const minIntervalMs = typeof out.minIntervalMs === "number" && Number.isFinite(out.minIntervalMs) && out.minIntervalMs >= 0
    ? out.minIntervalMs
    : 500;
  const streaming = out.streaming === false ? false : true;
  const cardkit = out.cardkit === false ? false : true;
  const streamMinEditIntervalMs = positiveNumberOrUndefined(out.streamMinEditIntervalMs);
  const maxEditsPerMessage = positiveNumberOrUndefined(out.maxEditsPerMessage);
  const ws = (p.websocket ?? {}) as Record<string, unknown>;
  const handshakeTimeoutMs = positiveNumberOrUndefined(ws.handshakeTimeoutMs);
  const pingTimeout = positiveNumberOrUndefined(ws.pingTimeout);
  return {
    enabled: p.enabled === true,
    appId,
    appSecret,
    domain,
    mesh: first?.mesh ?? "",
    chatId: first?.chatId ?? "",
    botMentionId,
    botName,
    requireMention,
    allowSenders,
    outbound: {
      minIntervalMs,
      streaming,
      cardkit,
      ...(streamMinEditIntervalMs !== undefined ? { streamMinEditIntervalMs } : {}),
      ...(maxEditsPerMessage !== undefined ? { maxEditsPerMessage } : {}),
    },
    websocket: {
      ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : {}),
      ...(pingTimeout !== undefined ? { pingTimeout } : {}),
    },
    bindings,
  };
}

export function readFeishuConfig(root: string): FeishuConfigLoadResult {
  const path = feishuConfigPath(root);
  if (!existsSync(path)) {
    return { path, exists: false, configured: false, enabled: false, reason: "missing config" };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { path, exists: true, configured: false, enabled: false, reason: `cannot read config: ${String(e)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { path, exists: true, configured: false, enabled: false, reason: `invalid JSON: ${String(e)}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { path, exists: true, configured: false, enabled: false, reason: "config must be an object" };
  }
  const enabled = (parsed as Record<string, unknown>).enabled === true;
  if (!enabled) {
    return { path, exists: true, configured: true, enabled: false, reason: "enabled=false" };
  }
  const cfg = normalizeFeishuConfig(parsed);
  if (!cfg) {
    return { path, exists: true, configured: true, enabled: true, reason: "missing required fields (appId, appSecret)" };
  }
  return { path, exists: true, configured: true, enabled: true, config: cfg };
}

/** Load + validate config from `<root>/channels/feishu.json`. Returns undefined when the
 *  runtime channel should be disabled. */
export function loadFeishuConfig(root: string, log: (msg: string) => void = () => {}): FeishuChannelConfig | undefined {
  const result = readFeishuConfig(root);
  if (result.config) return result.config;
  log(`feishu channel: ${result.reason ?? "not configured"} at ${result.path}; channel disabled`);
  return undefined;
}

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeDomain(v: unknown): FeishuDomain {
  const s = strOrEmpty(v);
  return s || "feishu";
}

function normalizeBindings(
  p: Record<string, unknown>,
  defaults: { botMentionId: string; botName: string; requireMention: boolean; allowSenders: string[] },
): FeishuMeshBinding[] {
  const out: FeishuMeshBinding[] = [];
  const seenMeshes = new Set<string>();
  const seenChats = new Set<string>();

  const add = (raw: Record<string, unknown>, fallbackMesh?: string) => {
    const mesh = strOrEmpty(raw.mesh) || fallbackMesh || "";
    const chatId = strOrEmpty(raw.chatId) || strOrEmpty(raw.chat_id);
    if (!mesh || !chatId) return;
    if (seenMeshes.has(mesh) || seenChats.has(chatId)) return;
    seenMeshes.add(mesh);
    seenChats.add(chatId);
    const requireMention = raw.requireMention === undefined ? undefined : raw.requireMention === false ? false : true;
    const allowSenders = Array.isArray(raw.allowSenders)
      ? raw.allowSenders.filter((s): s is string => typeof s === "string" && s.length > 0)
      : undefined;
    const item: FeishuMeshBinding = {
      mesh,
      chatId,
    };
    const name = strOrEmpty(raw.name);
    const createdAt = strOrEmpty(raw.createdAt);
    const botMentionId = strOrEmpty(raw.botMentionId) || strOrEmpty(raw.botOpenId) || strOrEmpty(raw.botId);
    const botName = strOrEmpty(raw.botName);
    const source = raw.source === "auto" || raw.source === "manual" ? raw.source : undefined;
    if (name) item.name = name;
    if (createdAt) item.createdAt = createdAt;
    if (source) item.source = source;
    if (botMentionId && botMentionId !== defaults.botMentionId) item.botMentionId = botMentionId;
    if (botName && botName !== defaults.botName) item.botName = botName;
    if (requireMention !== undefined && requireMention !== defaults.requireMention) item.requireMention = requireMention;
    if (allowSenders && JSON.stringify(allowSenders) !== JSON.stringify(defaults.allowSenders)) item.allowSenders = allowSenders;
    out.push(item);
  };

  if (Array.isArray(p.bindings)) {
    for (const raw of p.bindings) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) add(raw as Record<string, unknown>);
    }
  }

  const chats = p.chats ?? p.meshChats;
  if (chats && typeof chats === "object" && !Array.isArray(chats)) {
    for (const [mesh, raw] of Object.entries(chats as Record<string, unknown>)) {
      if (typeof raw === "string") add({ chatId: raw }, mesh);
      else if (raw && typeof raw === "object" && !Array.isArray(raw)) add(raw as Record<string, unknown>, mesh);
    }
  }

  add(p); // legacy top-level mesh/chatId
  return out;
}

function positiveNumberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}
