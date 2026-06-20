// src/cli-host-bearer.ts — host-key-derived, short-lived, SCOPED bearer for the `mesh` CLI's
// single-mesh lifecycle commands (design: docs/design/mesh-cli-lifecycle.md §A, Approach 2).
//
// Trust model: the CLI runs on the host with filesystem access to `<root>/auth/keys.json` (the same
// symmetric AES-256 key store `auth-codes.ts` uses for Feishu authcodes). Possession of that key IS host
// authority. The CLI proves possession by computing an HMAC-SHA256 over short-TTL, scoped claims; the
// backend re-derives the SAME MAC from its own copy of keys.json and verifies it. This is a
// CRYPTOGRAPHIC PROOF OF KEY POSSESSION — it is NOT a loopback/bind/env trust bypass. The device-auth
// gate stays mandatory; this is an ADDITIONAL, strictly narrower accept-path (gate enforces the scope).
//
// Hygiene: we do NOT use the raw AES-GCM key as an HMAC key (one key, two primitives). We derive a
// distinct sub-key via HKDF-SHA256 with a fixed info label, so the bearer MAC is cryptographically
// independent of the authcode encryption. This module NEVER logs a key or a token.

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { ensureKeys, loadKeys, type KeysFile } from "./auth-codes";

const BEARER_PREFIX = "mhk1"; // "mesh host key v1" — namespaces the bearer; a device token is bare base64url (no dots)
const HKDF_INFO = "mesh-cli-lifecycle-bearer-v1";
const SUBKEY_BYTES = 32;
const AES_KEY_BYTES = 32;
const DEFAULT_TTL_SECONDS = 60;
const MAX_CLOCK_SKEW_SECONDS = 60; // tolerate a small `iat`-in-the-future skew; reject anything beyond

/** Locked scope + audience — the ONLY values the gate accepts (any other → deny). */
export const HOST_BEARER_SCOPE = "mesh.lifecycle";
export const HOST_BEARER_AUDIENCE = "mesh-control-plane";

/** The signed claims (epoch SECONDS). `kid` selects the key.json key so a bearer signed before a key
 *  rotation still verifies while that kid is retained. `nonce` is anti-collision (replay is bounded by
 *  the short `exp`, per the approved decision — no nonce-seen cache for now). */
export interface HostBearerClaims {
  v: number;
  kid: string;
  iat: number;
  exp: number;
  scope: string;
  aud: string;
  nonce: string;
}

export interface HostBearerVerifyResult {
  ok: boolean;
  /** present only when ok — the claims' scope, for the gate's route-whitelist policy. */
  scope?: string;
}

/** Cheap prefix test: is this token a host-key bearer (vs a device token)? Lets the gate route a
 *  `mhk1.…` token to host-key verification and NEVER fall back to the device-token path for it. */
export function isHostBearer(token: string | undefined): token is string {
  return typeof token === "string" && token.startsWith(`${BEARER_PREFIX}.`);
}

/** The base64-decoded 32-byte raw secret for `kid`, or null (unknown kid / malformed / wrong length). */
function rawKeyFor(keys: KeysFile, kid: string): Buffer | null {
  const entry = keys.keys?.[kid];
  if (!entry || typeof entry.secret !== "string") return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(entry.secret, "base64");
  } catch {
    return null;
  }
  return raw.length === AES_KEY_BYTES ? raw : null;
}

/** Derive the bearer sub-key (HKDF-SHA256) — distinct from the AES-GCM key the same bytes back. */
function deriveSubKey(rawKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", rawKey, Buffer.alloc(0), HKDF_INFO, SUBKEY_BYTES));
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/** Sign a fresh host-key bearer against the store's ACTIVE key. `ensureKeys` lazily creates `k1` on a
 *  cold store (idempotent, cross-process locked), so the CLI can always sign. Returns
 *  `mhk1.<b64url(claims)>.<b64url(mac)>`. The raw token is the secret; we never persist or log it. */
export async function signHostBearer(root: string, opts: { now?: () => number; ttlSeconds?: number } = {}): Promise<string> {
  const keys = await ensureKeys(root);
  const kid = keys.active;
  const rawKey = rawKeyFor(keys, kid);
  if (!rawKey) throw new Error("host bearer: no usable active key");
  const iat = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const exp = iat + Math.max(1, Math.floor(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS));
  const claims: HostBearerClaims = {
    v: 1,
    kid,
    iat,
    exp,
    scope: HOST_BEARER_SCOPE,
    aud: HOST_BEARER_AUDIENCE,
    nonce: randomBytes(12).toString("base64url"),
  };
  const claimsB64 = b64urlJson(claims);
  const signed = `${BEARER_PREFIX}.${claimsB64}`;
  const mac = createHmac("sha256", deriveSubKey(rawKey)).update(signed).digest();
  return `${signed}.${mac.toString("base64url")}`;
}

/** Verify a host-key bearer against `keys` (loaded by the caller; pure — no IO). Validation order:
 *  structure → scope/aud/kid presence → key lookup → TIMING-SAFE MAC compare → expiry/skew. Every
 *  failure collapses to `{ok:false}` (no probing which check failed). Never throws on malformed input. */
export function verifyHostBearer(keys: KeysFile | undefined, token: string, opts: { now?: () => number } = {}): HostBearerVerifyResult {
  if (!keys || typeof token !== "string") return { ok: false };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== BEARER_PREFIX) return { ok: false };
  const [, claimsB64, macB64] = parts;

  let claims: Partial<HostBearerClaims> | null;
  try {
    claims = JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false };
  }
  if (
    !claims ||
    typeof claims !== "object" ||
    claims.v !== 1 ||
    typeof claims.kid !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.scope !== HOST_BEARER_SCOPE || // strict scope
    claims.aud !== HOST_BEARER_AUDIENCE || // strict audience
    typeof claims.nonce !== "string"
  ) {
    return { ok: false };
  }

  const rawKey = rawKeyFor(keys, claims.kid); // unknown/rotated-out kid → deny
  if (!rawKey) return { ok: false };

  // Recompute the MAC over the EXACT received signed bytes (no re-canonicalization) and compare in
  // constant time. A forged/tampered/truncated MAC fails here.
  const expectedMac = createHmac("sha256", deriveSubKey(rawKey)).update(`${BEARER_PREFIX}.${claimsB64}`).digest();
  let presentedMac: Buffer;
  try {
    presentedMac = Buffer.from(macB64, "base64url");
  } catch {
    return { ok: false };
  }
  if (presentedMac.length !== expectedMac.length) return { ok: false }; // timingSafeEqual needs equal length
  if (!timingSafeEqual(presentedMac, expectedMac)) return { ok: false };

  // Time checks LAST: a tampered exp is already covered by the MAC (it's part of the signed claims), so
  // reaching here means the exp is authentic. Reject if expired or implausibly future-dated.
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  if (now >= claims.exp) return { ok: false }; // expired (incl. replay of an expired bearer)
  if (claims.iat > now + MAX_CLOCK_SKEW_SECONDS) return { ok: false };

  return { ok: true, scope: claims.scope };
}

/** Load keys + verify in one call for the gate (async convenience over the pure `verifyHostBearer`). */
export async function verifyHostBearerFromRoot(root: string, token: string, opts: { now?: () => number } = {}): Promise<HostBearerVerifyResult> {
  return verifyHostBearer(await loadKeys(root), token, opts);
}
