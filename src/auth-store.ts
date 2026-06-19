// Authorization state store for device/account auth (design: docs/design/device-auth.md §1).
//
// Two JSON files under `<root>/auth/` (dir 0700, files 0600), distinct from `channels/feishu.json`:
//
//  - devices.json — WebUI device tokens: an `devices` allowlist (approved/revoked, hashed token) +
//    `pending` device-code registrations + an optional one-time `bootstrap` token (design §6) so a
//    cold, remote-only start is never locked out.
//  - feishu.json  — the Feishu `(channelKey, openId)` authorization registry: an `allow` map +
//    `pending` registrations whose `encryptedToken` is the AES-256-GCM envelope (auth-codes §2).
//
// Both are file-backed so the running backend and a separate `mesh …` CLI can share state with no IPC.
// Writes are atomic (tmp+rename) and serialized by the shared `withFileLock` (in-process lock + a
// cross-process advisory lockfile) — the WHOLE read-modify-write runs under the lock so a CLI approve
// and a backend touch can never clobber each other. Reads defensively sanitize and GC expired pending
// entries (mirrors session-storage / board-store), so a hand-edited or version-skewed file never
// crashes a consumer.
//
// Raw bearer tokens are NEVER stored — only `sha256:` hashes (verify via constant-time
// `verifyTokenHash`). This module never logs.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, authDir, verifyTokenHash, withFileLock } from "./auth-codes";

// ── schema ───────────────────────────────────────────────────────────────────

export type AuthStatus = "approved" | "revoked";

export interface DeviceRecord {
  label?: string;
  status: AuthStatus;
  tokenHash: string; // sha256:… of the bearer token; raw token never stored
  createdAt: string;
  approvedAt?: string;
  lastSeenAt?: string;
}

export interface DevicePending {
  deviceId: string;
  tokenHash: string; // token already issued, dormant until approved
  userAgentClass?: string; // coarse, non-PII hint for the operator; never the raw UA
  remoteHint?: string; // coarse origin class
  createdAt: string;
  expiresAt: string;
}

/** A single-use, short-TTL token printed at startup (design §6) to bootstrap the first remote device. */
export interface BootstrapToken {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface DevicesFile {
  version: number;
  devices: Record<string, DeviceRecord>;
  pending: Record<string, DevicePending>;
  bootstrap?: BootstrapToken;
}

export interface FeishuAllowEntry {
  channelKey: string;
  openId: string;
  status: AuthStatus;
  approvedAt: string;
  note?: string;
}

export interface FeishuPending {
  encryptedToken: string; // the full AES-256-GCM envelope — the source of truth
  channelKey: string; // decoded copy, for `mesh feishu list` display (advisory)
  openId: string;
  appId: string;
  firstSeenAt: string;
  expiresAt: string;
}

export interface FeishuAuthFile {
  version: number;
  allow: Record<string, FeishuAllowEntry>;
  pending: Record<string, FeishuPending>;
}

const MAX_STR = 4000;
const MAX_ID = 200;

export function emptyDevices(): DevicesFile {
  return { version: 1, devices: {}, pending: {} };
}

export function emptyFeishuAuth(): FeishuAuthFile {
  return { version: 1, allow: {}, pending: {} };
}

// ── paths ────────────────────────────────────────────────────────────────────

export function devicesPath(root: string): string {
  return join(authDir(root), "devices.json");
}

export function feishuAuthPath(root: string): string {
  return join(authDir(root), "feishu.json");
}

/** The text-safe composite key for a Feishu allow entry: base64url(JSON.stringify([channelKey, openId])).
 *  No raw delimiter, so neither field can collide or smuggle a separator (design §1.2). */
export function feishuAllowKey(channelKey: string, openId: string): string {
  return Buffer.from(JSON.stringify([channelKey, openId]), "utf8").toString("base64url");
}

// ── sanitize helpers ─────────────────────────────────────────────────────────

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}
function statusOr(v: unknown): AuthStatus {
  // Anything we cannot read as an explicit "approved" is treated as "revoked" — a malformed status
  // must never grant access.
  return v === "approved" ? "approved" : "revoked";
}
/** A valid ISO timestamp string, or undefined. */
function isoOrUndef(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return Number.isNaN(Date.parse(v)) ? undefined : v;
}
/** True if `iso` parses and is at or before `now` (ms). Unparseable → treated as expired (drop). */
function isExpired(iso: string, now: number): boolean {
  const t = Date.parse(iso);
  return Number.isNaN(t) || t <= now;
}

// ── devices.json sanitize / read / write ─────────────────────────────────────

function sanitizeDeviceRecord(raw: unknown): DeviceRecord | undefined {
  const o = asObject(raw);
  if (!o) return undefined;
  const tokenHash = cleanStr(o.tokenHash, MAX_ID);
  const createdAt = isoOrUndef(o.createdAt);
  if (!tokenHash || !createdAt) return undefined; // a record we cannot anchor is dropped
  const rec: DeviceRecord = { status: statusOr(o.status), tokenHash, createdAt };
  const label = cleanStr(o.label, MAX_ID);
  const approvedAt = isoOrUndef(o.approvedAt);
  const lastSeenAt = isoOrUndef(o.lastSeenAt);
  if (label) rec.label = label;
  if (approvedAt) rec.approvedAt = approvedAt;
  if (lastSeenAt) rec.lastSeenAt = lastSeenAt;
  return rec;
}

function sanitizeDevicePending(raw: unknown, now: number): DevicePending | undefined {
  const o = asObject(raw);
  if (!o) return undefined;
  const deviceId = cleanStr(o.deviceId, MAX_ID);
  const tokenHash = cleanStr(o.tokenHash, MAX_ID);
  const createdAt = isoOrUndef(o.createdAt);
  const expiresAt = isoOrUndef(o.expiresAt);
  if (!deviceId || !tokenHash || !createdAt || !expiresAt) return undefined;
  if (isExpired(expiresAt, now)) return undefined; // GC expired pending on read
  const p: DevicePending = { deviceId, tokenHash, createdAt, expiresAt };
  const uac = cleanStr(o.userAgentClass, MAX_ID);
  const remote = cleanStr(o.remoteHint, MAX_ID);
  if (uac) p.userAgentClass = uac;
  if (remote) p.remoteHint = remote;
  return p;
}

function sanitizeBootstrap(raw: unknown): BootstrapToken | undefined {
  const o = asObject(raw);
  if (!o) return undefined;
  const tokenHash = cleanStr(o.tokenHash, MAX_ID);
  const createdAt = isoOrUndef(o.createdAt);
  const expiresAt = isoOrUndef(o.expiresAt);
  if (!tokenHash || !createdAt || !expiresAt) return undefined;
  const b: BootstrapToken = { tokenHash, createdAt, expiresAt };
  const consumedAt = isoOrUndef(o.consumedAt);
  if (consumedAt) b.consumedAt = consumedAt;
  return b;
}

export function sanitizeDevices(parsed: unknown, now: number = Date.now()): DevicesFile {
  const o = asObject(parsed);
  if (!o) return emptyDevices();
  const devices: Record<string, DeviceRecord> = {};
  const pdev = asObject(o.devices);
  if (pdev) {
    for (const [id, value] of Object.entries(pdev)) {
      const rec = sanitizeDeviceRecord(value);
      if (rec) devices[id.slice(0, MAX_ID)] = rec;
    }
  }
  const pending: Record<string, DevicePending> = {};
  const ppend = asObject(o.pending);
  if (ppend) {
    for (const [code, value] of Object.entries(ppend)) {
      const p = sanitizeDevicePending(value, now);
      if (p) pending[code.slice(0, MAX_ID)] = p;
    }
  }
  const out: DevicesFile = { version: typeof o.version === "number" ? o.version : 1, devices, pending };
  const bootstrap = sanitizeBootstrap(o.bootstrap);
  if (bootstrap) out.bootstrap = bootstrap;
  return out;
}

/** Read devices.json (sanitized + expired-pending GC'd); empty store on absent/corrupt. No lock. */
export async function readDevices(root: string, now: number = Date.now()): Promise<DevicesFile> {
  try {
    return sanitizeDevices(JSON.parse(await readFile(devicesPath(root), "utf8")), now);
  } catch {
    return emptyDevices();
  }
}

/** Atomic, lock-serialized write of devices.json (0600). */
export async function writeDevices(root: string, file: DevicesFile): Promise<void> {
  await withFileLock(devicesPath(root), () =>
    atomicWriteFile(devicesPath(root), JSON.stringify(sanitizeDevices(file), null, 2), 0o600),
  );
}

/** Concurrency-safe read-modify-write of devices.json: the read, the mutator, and the write all run
 *  under one lock so a CLI approve and a backend touch never clobber each other. */
export async function updateDevices(
  root: string,
  mutator: (file: DevicesFile) => void | DevicesFile,
  now: number = Date.now(),
): Promise<DevicesFile> {
  return withFileLock(devicesPath(root), async () => {
    let current: DevicesFile;
    try {
      current = sanitizeDevices(JSON.parse(await readFile(devicesPath(root), "utf8")), now);
    } catch {
      current = emptyDevices();
    }
    const mutated = mutator(current) ?? current;
    const clean = sanitizeDevices(mutated, now);
    await atomicWriteFile(devicesPath(root), JSON.stringify(clean, null, 2), 0o600);
    return clean;
  });
}

// ── feishu.json sanitize / read / write ──────────────────────────────────────

function sanitizeFeishuAllow(raw: unknown): FeishuAllowEntry | undefined {
  const o = asObject(raw);
  if (!o) return undefined;
  const channelKey = cleanStr(o.channelKey, MAX_ID);
  const openId = cleanStr(o.openId, MAX_ID);
  const approvedAt = isoOrUndef(o.approvedAt);
  if (!channelKey || !openId || !approvedAt) return undefined;
  const entry: FeishuAllowEntry = { channelKey, openId, status: statusOr(o.status), approvedAt };
  const note = cleanStr(o.note, MAX_STR);
  if (note) entry.note = note;
  return entry;
}

function sanitizeFeishuPending(raw: unknown, now: number): FeishuPending | undefined {
  const o = asObject(raw);
  if (!o) return undefined;
  const encryptedToken = cleanStr(o.encryptedToken, MAX_STR);
  const channelKey = cleanStr(o.channelKey, MAX_ID);
  const openId = cleanStr(o.openId, MAX_ID);
  const appId = cleanStr(o.appId, MAX_ID);
  const firstSeenAt = isoOrUndef(o.firstSeenAt);
  const expiresAt = isoOrUndef(o.expiresAt);
  if (!encryptedToken || !channelKey || !openId || !appId || !firstSeenAt || !expiresAt) return undefined;
  if (isExpired(expiresAt, now)) return undefined; // GC expired pending on read
  return { encryptedToken, channelKey, openId, appId, firstSeenAt, expiresAt };
}

export function sanitizeFeishuAuth(parsed: unknown, now: number = Date.now()): FeishuAuthFile {
  const o = asObject(parsed);
  if (!o) return emptyFeishuAuth();
  const allow: Record<string, FeishuAllowEntry> = {};
  const pallow = asObject(o.allow);
  if (pallow) {
    // The entry fields are the source of truth — re-key under the canonical
    // feishuAllowKey(channelKey, openId) rather than trusting the stored JSON key. A hand-edited or
    // migrated file whose key drifted from its (channelKey, openId) is healed here, so the canonical
    // lookup in isFeishuAllowed always finds a valid entry (and a stale wrong key is not retained).
    for (const value of Object.values(pallow)) {
      const entry = sanitizeFeishuAllow(value);
      if (entry) allow[feishuAllowKey(entry.channelKey, entry.openId)] = entry;
    }
  }
  const pending: Record<string, FeishuPending> = {};
  const ppend = asObject(o.pending);
  if (ppend) {
    for (const [id, value] of Object.entries(ppend)) {
      const p = sanitizeFeishuPending(value, now);
      if (p) pending[id.slice(0, MAX_ID)] = p;
    }
  }
  return { version: typeof o.version === "number" ? o.version : 1, allow, pending };
}

/** Read feishu.json auth registry (sanitized + expired-pending GC'd); empty on absent/corrupt. No lock. */
export async function readFeishuAuth(root: string, now: number = Date.now()): Promise<FeishuAuthFile> {
  try {
    return sanitizeFeishuAuth(JSON.parse(await readFile(feishuAuthPath(root), "utf8")), now);
  } catch {
    return emptyFeishuAuth();
  }
}

/** Atomic, lock-serialized write of feishu.json (0600). */
export async function writeFeishuAuth(root: string, file: FeishuAuthFile): Promise<void> {
  await withFileLock(feishuAuthPath(root), () =>
    atomicWriteFile(feishuAuthPath(root), JSON.stringify(sanitizeFeishuAuth(file), null, 2), 0o600),
  );
}

/** Concurrency-safe read-modify-write of feishu.json (read+mutate+write under one lock). */
export async function updateFeishuAuth(
  root: string,
  mutator: (file: FeishuAuthFile) => void | FeishuAuthFile,
  now: number = Date.now(),
): Promise<FeishuAuthFile> {
  return withFileLock(feishuAuthPath(root), async () => {
    let current: FeishuAuthFile;
    try {
      current = sanitizeFeishuAuth(JSON.parse(await readFile(feishuAuthPath(root), "utf8")), now);
    } catch {
      current = emptyFeishuAuth();
    }
    const mutated = mutator(current) ?? current;
    const clean = sanitizeFeishuAuth(mutated, now);
    await atomicWriteFile(feishuAuthPath(root), JSON.stringify(clean, null, 2), 0o600);
    return clean;
  });
}

// ── read-side queries (pure, for the hot path / verify) ──────────────────────

/** Return the deviceId of the approved device whose token matches, else undefined. Scans the WHOLE
 *  allowlist (no early return) so the lookup time does not reveal the matching device's position in
 *  the map; the constant-time `verifyTokenHash` runs for every approved candidate. Revoked / pending
 *  devices never match. */
export function findApprovedDeviceId(file: DevicesFile, token: string): string | undefined {
  let matched: string | undefined;
  for (const [id, rec] of Object.entries(file.devices)) {
    if (rec.status === "approved" && verifyTokenHash(token, rec.tokenHash)) matched = id;
  }
  return matched;
}

/** True iff `(channelKey, openId)` is present and approved. */
export function isFeishuAllowed(file: FeishuAuthFile, channelKey: string, openId: string): boolean {
  return file.allow[feishuAllowKey(channelKey, openId)]?.status === "approved";
}

/** True iff a live (unconsumed, unexpired) bootstrap token matches. */
export function bootstrapTokenValid(file: DevicesFile, token: string, now: number = Date.now()): boolean {
  const b = file.bootstrap;
  if (!b || b.consumedAt) return false;
  if (isExpired(b.expiresAt, now)) return false;
  return verifyTokenHash(token, b.tokenHash);
}
