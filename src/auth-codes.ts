// Authorization-code cryptography + key store for device/account auth (design: docs/design/device-auth.md §2).
//
// Two concerns live here, both pure-ish and unit-testable without the rest of the system:
//
//  1. Feishu authorization codes — AES-256-GCM (AEAD) encrypt/decrypt of a self-describing envelope
//     `base64url(JSON.stringify({ v, kid, iv, tag, ct }))` whose plaintext carries
//     `(channelKey, openId, appId, iat, exp, nonce)`. The GCM tag makes the code unforgeable and the
//     encryption keeps it opaque to the user; only the host (holding the key) can decrypt it. A user
//     cannot mint a code for another (channel, open_id) without the host key.
//
//  2. The key store `<root>/auth/keys.json` — 32-byte AES-256 keys with a string `kid`, an `active`
//     key for new codes, and retained older keys so codes minted before a rotation still decrypt until
//     they expire. The envelope's `kid` selects which key to decrypt with.
//
// Plus small token-hash utilities (sha256 + constant-time verify) used by the device-token allowlist.
//
// Security posture (per dispatch): this module NEVER logs. Tamper / unknown-kid / expired all reject
// safely via `AuthCodeError` with a generic, key-free, plaintext-free message; the raw crypto error and
// the key bytes never escape. The caller decides what (if anything) to surface.

import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

// ── constants ────────────────────────────────────────────────────────────────

const AES_KEY_BYTES = 32; // AES-256
const GCM_IV_BYTES = 12; // 96-bit IV, GCM's recommended size; fresh per code
const GCM_TAG_BYTES = 16; // 128-bit auth tag
const NONCE_BYTES = 16; // in-payload replay-guard id (independent of the IV)
const ENVELOPE_VERSION = 1;
const PAYLOAD_VERSION = 1;
const DEVICE_TOKEN_BYTES = 32;

// ── errors ───────────────────────────────────────────────────────────────────

/** A safe, caller-presentable failure. Carries a coarse `reason` and NEVER the raw crypto error,
 *  the key, or any plaintext. tamper/wrong-key/truncation/unknown-kid all collapse to "invalid". */
export type AuthCodeFailure = "invalid" | "expired";

export class AuthCodeError extends Error {
  readonly reason: AuthCodeFailure;
  constructor(reason: AuthCodeFailure) {
    super(reason === "expired" ? "authorization code expired" : "invalid or unrecognized authorization code");
    this.name = "AuthCodeError";
    this.reason = reason;
  }
}

// ── key store types ────────────────────────────────────────────────────────────

export interface StoredKey {
  /** base64 of 32 random bytes. */
  secret: string;
  createdAt: string;
}

export interface KeysFile {
  version: number;
  /** kid of the key used to encrypt NEW codes. */
  active: string;
  /** all keys, keyed by kid ("k1", "k2", …); retained ones still decrypt outstanding codes. */
  keys: Record<string, StoredKey>;
}

// ── auth-code payload ──────────────────────────────────────────────────────────

/** What the host recovers from a valid code. `iat`/`exp` are epoch seconds. */
export interface AuthCodePayload {
  channelKey: string;
  openId: string;
  appId: string;
  iat: number;
  exp: number;
  nonce: string;
}

export interface EncryptInput {
  channelKey: string;
  openId: string;
  appId: string;
  /** lifetime in seconds from `now`. */
  ttlSeconds: number;
  /** injectable clock (epoch ms) for tests; defaults to Date.now. */
  now?: () => number;
  /** injectable nonce for tests; defaults to random. */
  nonce?: string;
}

// ── base64url helpers ──────────────────────────────────────────────────────────

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function fromB64url(s: string): Buffer {
  if (typeof s !== "string" || s.length === 0) throw new AuthCodeError("invalid");
  return Buffer.from(s, "base64url");
}

function nowSeconds(now?: () => number): number {
  return Math.floor((now ? now() : Date.now()) / 1000);
}

// ── auth-code encrypt / decrypt ─────────────────────────────────────────────────

function keyBytesFor(keys: KeysFile, kid: string): Buffer | undefined {
  const entry = keys.keys?.[kid];
  if (!entry || typeof entry.secret !== "string") return undefined;
  let raw: Buffer;
  try {
    raw = Buffer.from(entry.secret, "base64");
  } catch {
    return undefined;
  }
  return raw.length === AES_KEY_BYTES ? raw : undefined;
}

/** Encrypt a Feishu authorization code with the store's ACTIVE key. Returns the opaque base64url
 *  envelope. Throws AuthCodeError("invalid") if the active key is missing/corrupt. */
export function encryptAuthCode(keys: KeysFile, input: EncryptInput): string {
  const kid = keys?.active;
  const key = kid ? keyBytesFor(keys, kid) : undefined;
  if (!kid || !key) throw new AuthCodeError("invalid");

  const iat = nowSeconds(input.now);
  const exp = iat + Math.max(1, Math.floor(input.ttlSeconds));
  const nonce = input.nonce ?? b64url(randomBytes(NONCE_BYTES));
  const plaintext = JSON.stringify({
    v: PAYLOAD_VERSION,
    ck: input.channelKey,
    oid: input.openId,
    app: input.appId,
    iat,
    exp,
    n: nonce,
  });

  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = {
    v: ENVELOPE_VERSION,
    kid,
    iv: b64url(iv),
    tag: b64url(tag),
    ct: b64url(ct),
  };
  return b64url(Buffer.from(JSON.stringify(envelope), "utf8"));
}

/** Decrypt + validate a Feishu authorization code. Validation order (per design §2.1): GCM tag (via
 *  `final()`) → exp not passed → payload version known. Replay-guard (nonce consumption) is the
 *  caller's job (tracked in the auth store), not here. Throws AuthCodeError on any failure. */
export function decryptAuthCode(keys: KeysFile, code: string, opts?: { now?: () => number }): AuthCodePayload {
  // 1. Parse the outer envelope.
  let envelope: { v?: unknown; kid?: unknown; iv?: unknown; tag?: unknown; ct?: unknown };
  try {
    envelope = JSON.parse(fromB64url(code).toString("utf8"));
  } catch {
    throw new AuthCodeError("invalid");
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.v !== ENVELOPE_VERSION ||
    typeof envelope.kid !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ct !== "string"
  ) {
    throw new AuthCodeError("invalid");
  }

  // 2. Select the key by kid (unknown kid → invalid, same generic failure).
  const key = keyBytesFor(keys, envelope.kid);
  if (!key) throw new AuthCodeError("invalid");

  // 3. Decrypt; a wrong key / tamper / truncation makes final() throw → invalid.
  let plaintext: string;
  try {
    const iv = fromB64url(envelope.iv);
    const tag = fromB64url(envelope.tag);
    const ct = fromB64url(envelope.ct);
    if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) throw new Error("bad sizes");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new AuthCodeError("invalid");
  }

  // 4. Parse the plaintext payload.
  let payload: { v?: unknown; ck?: unknown; oid?: unknown; app?: unknown; iat?: unknown; exp?: unknown; n?: unknown };
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw new AuthCodeError("invalid");
  }
  if (!payload || typeof payload !== "object") throw new AuthCodeError("invalid");

  // 5. Expiry BEFORE version/field validation (spec §2.1 order: tag → exp → v → fields). A
  //    GCM-valid but expired code reports "expired" even if its version/fields are otherwise
  //    off, so an expired old-format code never masquerades as a tamper ("invalid").
  if (typeof payload.exp === "number" && nowSeconds(opts?.now) >= payload.exp) {
    throw new AuthCodeError("expired");
  }

  // 6. Version + required fields (any mismatch → invalid).
  if (
    payload.v !== PAYLOAD_VERSION ||
    typeof payload.ck !== "string" ||
    typeof payload.oid !== "string" ||
    typeof payload.app !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    typeof payload.n !== "string"
  ) {
    throw new AuthCodeError("invalid");
  }

  return {
    channelKey: payload.ck,
    openId: payload.oid,
    appId: payload.app,
    iat: payload.iat,
    exp: payload.exp,
    nonce: payload.n,
  };
}

// ── token-hash utilities (device-token allowlist) ────────────────────────────────

/** A fresh opaque bearer token (random secret), base64url. The raw token is shown to the client once;
 *  the store keeps only its hash. */
export function generateToken(bytes: number = DEVICE_TOKEN_BYTES): string {
  return b64url(randomBytes(bytes));
}

/** `sha256:<hex>` of a token. The store persists this, never the raw token. */
export function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/** Constant-time verify of a presented token against a stored hash. Length-mismatched or malformed
 *  hashes return false WITHOUT throwing (timingSafeEqual requires equal-length buffers). */
export function verifyTokenHash(token: string, storedHash: string): boolean {
  if (typeof token !== "string" || typeof storedHash !== "string") return false;
  const computed = Buffer.from(hashToken(token), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

// ── key store IO (`<root>/auth/keys.json`) ───────────────────────────────────────

/** The `<root>/auth` directory (shared by keys.json and, later, devices/feishu.json). */
export function authDir(root: string): string {
  return join(root, "auth");
}

export function authKeysPath(root: string): string {
  return join(authDir(root), "keys.json");
}

// ── shared auth-store fs primitives (used here for keys.json and by auth-store.ts) ───────────────
//
// Two writers can touch an auth file: the running backend and a separate `mesh …` CLI process. So a
// safe read-modify-write needs BOTH an in-process per-path lock (board-store / mailbox pattern) AND a
// cross-process advisory lockfile. `withFileLock` composes them: in-process callers serialize on the
// promise chain first, then exactly one of them arbitrates with other OS processes via the lockfile.
// These live in this (lower-level) module so auth-store.ts can import them without a cycle.

const fileLocks = new Map<string, Promise<unknown>>();
const LOCK_STALE_MS = 15_000; // a lockfile older than this is assumed orphaned (crashed holder) and broken
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withInProcLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current, () => current);
  fileLocks.set(path, chained);
  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (fileLocks.get(path) === chained) fileLocks.delete(path);
  }
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

/** The lock-file body: a UNIQUE owner token (random UUID) plus pid + createdAt. The random owner lets
 *  release verify it only removes the lock THIS process created — never another owner's. */
function makeLockOwner(): string {
  return JSON.stringify({ owner: randomUUID(), pid: process.pid, createdAt: Date.now() });
}

/** Age of a lock body in ms. Prefers the in-payload `createdAt` (filesystem-clock-independent); falls
 *  back to the file mtime for a legacy/foreign/corrupt body. Used only for diagnostics. */
function lockAgeMs(content: string, mtimeMs: number): number {
  try {
    const o = JSON.parse(content) as { createdAt?: unknown };
    if (typeof o?.createdAt === "number") return Date.now() - o.createdAt;
  } catch {
    /* not our JSON body — fall back to mtime */
  }
  return Date.now() - mtimeMs;
}

/** Acquire the cross-process lock by exclusive create, returning the unique owner token we wrote.
 *
 *  FAIL CLOSED: we NEVER auto-delete a lock we did not create. A leftover lock from a crashed holder
 *  is an availability problem (resolved by manual cleanup), but auto-unlinking a stale lock is a
 *  correctness/security problem — any check-then-unlink has a TOCTOU window that can admit two
 *  concurrent writers into an auth/key read-modify-write. Auth RMW sections are short, so on a held
 *  lock we simply wait up to `timeoutMs` and then throw a clear, path-naming error. `staleMs` is used
 *  only to annotate that error (so an operator knows the lock looks orphaned), not to delete. */
async function acquireLockfile(lockPath: string, opts?: FileLockOptions): Promise<string> {
  const staleMs = opts?.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + (opts?.timeoutMs ?? LOCK_TIMEOUT_MS);
  const owner = makeLockOwner();
  for (;;) {
    try {
      const fh = await open(lockPath, "wx"); // exclusive create — fails EEXIST if held
      try {
        await fh.write(owner);
      } finally {
        await fh.close();
      }
      return owner; // we hold it (and only we know `owner`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        // Held past the timeout. Inspect (read-only) purely to make the error actionable.
        let hint = `: ${lockPath}`;
        try {
          const content = await readFile(lockPath, "utf8");
          const st = await stat(lockPath);
          if (lockAgeMs(content, st.mtimeMs) > staleMs) hint = `; stale lock may require manual cleanup: ${lockPath}`;
        } catch {
          continue; // vanished right at the deadline → loop once more and try the exclusive create
        }
        throw new Error(`auth file lock timeout${hint}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/** Release a lock we hold. Owner-aware: only remove the file if it still carries OUR owner token, so
 *  we never delete a lock created by someone else (defends a release-time TOCTOU). Best-effort and
 *  silent — release must not throw or mask the locked section's result. */
async function releaseLockfile(lockPath: string, owner: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) === owner) await rm(lockPath, { force: true }).catch(() => {});
  } catch {
    /* already gone / unreadable → nothing of ours to release */
  }
}

/** Run `run` holding both the in-process and cross-process locks for `path`. The whole
 *  read-modify-write must happen inside `run` so concurrent (same- or cross-process) callers can
 *  never both observe an absent file and double-create. Not re-entrant — callers must not nest
 *  `withFileLock` on the same path. */
export async function withFileLock<T>(path: string, run: () => Promise<T>, opts?: FileLockOptions): Promise<T> {
  return withInProcLock(path, async () => {
    const lockPath = `${path}.lock`;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 }).catch(() => {});
    const owner = await acquireLockfile(lockPath, opts);
    try {
      return await run();
    } finally {
      await releaseLockfile(lockPath, owner);
    }
  });
}

/** Atomic file write: tmp + fsync-free rename, dir 0700 / file `mode` (default 0600). Does NOT lock —
 *  call inside `withFileLock` for a concurrency-safe write. */
export async function atomicWriteFile(path: string, data: string, mode: number = 0o600): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path);
  await chmod(path, mode).catch(() => {});
}

function sanitizeKeys(parsed: unknown): KeysFile | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const p = parsed as { version?: unknown; active?: unknown; keys?: unknown };
  const keys: Record<string, StoredKey> = {};
  if (p.keys && typeof p.keys === "object") {
    for (const [kid, value] of Object.entries(p.keys as Record<string, unknown>)) {
      if (!/^k\d+$/.test(kid)) continue;
      const v = value as { secret?: unknown; createdAt?: unknown };
      if (!v || typeof v.secret !== "string") continue;
      // keep only well-formed 32-byte keys
      let raw: Buffer;
      try {
        raw = Buffer.from(v.secret, "base64");
      } catch {
        continue;
      }
      if (raw.length !== AES_KEY_BYTES) continue;
      keys[kid] = { secret: v.secret, createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date(0).toISOString() };
    }
  }
  const active = typeof p.active === "string" && keys[p.active] ? p.active : "";
  if (!active) return undefined; // no usable active key → treat as absent, force regeneration
  return { version: typeof p.version === "number" ? p.version : 1, active, keys };
}

/** Read the key store, or undefined if absent/unreadable/corrupt (caller may regenerate). */
export async function loadKeys(root: string): Promise<KeysFile | undefined> {
  try {
    return sanitizeKeys(JSON.parse(await readFile(authKeysPath(root), "utf8")));
  } catch {
    return undefined;
  }
}

async function writeKeysUnlocked(root: string, keys: KeysFile): Promise<void> {
  await atomicWriteFile(authKeysPath(root), JSON.stringify(keys, null, 2), 0o600);
}

/** Atomic write (tmp + rename), dir 0700 / file 0600. Serialized under the file lock. */
export async function saveKeys(root: string, keys: KeysFile): Promise<void> {
  await withFileLock(authKeysPath(root), () => writeKeysUnlocked(root, keys));
}

function nextKid(keys: Record<string, StoredKey>): string {
  let max = 0;
  for (const kid of Object.keys(keys)) {
    const m = /^k(\d+)$/.exec(kid);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `k${max + 1}`;
}

function freshKey(kid: string, now?: () => number): { kid: string; key: StoredKey } {
  return {
    kid,
    key: { secret: randomBytes(AES_KEY_BYTES).toString("base64"), createdAt: new Date(now ? now() : Date.now()).toISOString() },
  };
}

/** Return the key store, lazily creating a first active key (`k1`) on a cold store. Idempotent. The
 *  whole load-or-create runs under the file lock, so concurrent cold-start callers (same process or
 *  CLI-vs-backend) can never both see an absent store and generate divergent `k1` keys. */
export async function ensureKeys(root: string, now?: () => number): Promise<KeysFile> {
  return withFileLock(authKeysPath(root), async () => {
    const existing = await loadKeys(root);
    if (existing) return existing;
    const { kid, key } = freshKey("k1", now);
    const created: KeysFile = { version: 1, active: kid, keys: { [kid]: key } };
    await writeKeysUnlocked(root, created);
    return created;
  });
}

/** Add a new key, mark it active for new codes, and KEEP existing keys so outstanding codes still
 *  decrypt across the rotation overlap (until they expire and the old key is pruned out-of-band).
 *  Read-modify-write under the file lock (no nested lock — does its own load + write). */
export async function rotateKeys(root: string, now?: () => number): Promise<KeysFile> {
  return withFileLock(authKeysPath(root), async () => {
    let current = await loadKeys(root);
    if (!current) {
      const seed = freshKey("k1", now);
      current = { version: 1, active: seed.kid, keys: { [seed.kid]: seed.key } };
    }
    const { kid, key } = freshKey(nextKid(current.keys), now);
    const rotated: KeysFile = { version: current.version, active: kid, keys: { ...current.keys, [kid]: key } };
    await writeKeysUnlocked(root, rotated);
    return rotated;
  });
}
