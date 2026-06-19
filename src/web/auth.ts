// Web-layer device-auth consumer (design: docs/design/device-auth.md §4 & §6). This is the
// browser-facing half of device authorization: issue/poll/verify a device token and accept a
// one-time bootstrap token. It is a CONSUMER of the Phase 1 store/crypto primitives
// (src/auth-store.ts, src/auth-codes.ts) — it never re-implements hashing, locking, or the file
// schema, and never writes raw bearer tokens (only their sha256 hash, via the store).
//
// The CLI (Phase 2) is the sole approver: it moves a pending device → approved by mutating the
// store, which the backend simply reads here. This module never logs a token or a code.

import { randomBytes, randomUUID } from "node:crypto";
import { generateToken, hashToken, verifyTokenHash } from "../auth-codes";
import {
  bootstrapTokenValid,
  findApprovedDeviceId,
  readDevices,
  updateDevices,
  type DevicesFile,
} from "../auth-store";

/** Terminal/transient states the unauthorized page polls on. `unknown` = no matching record. */
export type DeviceAuthStatus = "pending" | "approved" | "revoked" | "unknown";

/** Pending device codes live this long before the store GCs them (design §4.2). */
const PENDING_TTL_MS = 10 * 60 * 1000;
/** Poll cadence the unauthorized page should use (design §4.2 / Open Q 4A: simple 2–3s poll). */
export const DEVICE_POLL_AFTER_MS = 2500;

export interface DeviceStartResult {
  code: string;
  deviceId: string;
  /** The raw bearer token — returned to the client ONCE so it can store it; the store keeps only its hash. */
  token: string;
  pollAfterMs: number;
}

/** Extract a bearer token from an Authorization header, or undefined. */
export function bearerToken(headers?: Headers): string | undefined {
  const h = headers?.get("authorization");
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  const t = m?.[1]?.trim();
  return t || undefined;
}

/** A COARSE, non-PII device class for the operator's `mesh device list` view — never the raw UA. */
export function coarseUserAgentClass(headers?: Headers): string {
  const ua = headers?.get("user-agent")?.toLowerCase() ?? "";
  if (!ua) return "unknown";
  return /mobi|android|iphone|ipad|ipod/.test(ua) ? "mobile" : "desktop";
}

function newDeviceId(): string {
  return `dv_${randomUUID().replace(/-/g, "")}`;
}

// ── request gate (design §6 trust model) ─────────────────────────────────────

export type RemoteClass = "loopback" | "remote";

/** Normalize a socket address for loopback comparison: lowercase, strip an IPv6 zone id and
 *  brackets, and unwrap an IPv4-mapped IPv6 (`::ffff:127.0.0.1`). */
function normalizeAddr(addr: string): string {
  let a = addr.trim().toLowerCase().replace(/%.*$/, "");
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  return a;
}

/** Classify a SOCKET-DERIVED remote address (never a header). Unknown/empty → `remote` (fail safe):
 *  an address we cannot read must never be granted loopback trust. Covers 127.0.0.0/8, ::1, and
 *  IPv4-mapped loopback. */
export function classifyRemoteAddress(remoteAddress: string | undefined): RemoteClass {
  if (!remoteAddress || typeof remoteAddress !== "string") return "remote";
  const a = normalizeAddr(remoteAddress);
  if (a === "::1") return "loopback";
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) return "loopback";
  return "remote";
}

/** Is the server BIND hostname loopback-only (the dev default, where implicit loopback trust is
 *  safe)? `undefined` → true, matching the server's own `?? "127.0.0.1"` default. A wildcard /
 *  LAN / tailnet bind (`0.0.0.0`, `::`, an IP, a hostname) is exposed → false. */
export function isLoopbackBind(hostname: string | undefined): boolean {
  if (hostname == null || hostname === "") return true;
  const h = normalizeAddr(hostname);
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Coarse, non-PII origin class recorded on a pending device for the operator's `mesh device list`. */
export function remoteHintFor(remoteClass: RemoteClass, bindExposed: boolean): string {
  if (remoteClass === "remote") return "remote";
  return bindExposed ? "exposed-loopback" : "loopback";
}

export interface AuthGateOptions {
  /** Auth store root; undefined disables the token path (loopback-only gate). */
  root: string | undefined;
  /** Bearer/query token presented by the caller, if any. */
  token: string | undefined;
  /** SOCKET-derived remote address (Bun `server.requestIP(req).address`); NEVER a header value. */
  remoteAddress: string | undefined;
  /** The server's bind hostname. */
  bindHostname: string | undefined;
  /** Escape hatch: trust loopback even on an exposed bind. Default false. */
  trustLoopbackWhenExposed?: boolean;
}

export interface AuthGateResult {
  ok: boolean;
  via: "token" | "loopback" | "denied";
  remoteClass: RemoteClass;
  bindExposed: boolean;
}

/** The authoritative gate for non-device `/api/*` and `/ws`. Approved device token wins regardless
 *  of origin; otherwise implicit loopback trust is granted ONLY when the remote is loopback AND the
 *  bind is loopback-only (or the explicit exposed-loopback override is on). Everything else is denied.
 *  Pure (apart from reading the device store) and header-free, so a spoofed `X-Forwarded-*` can never
 *  change the decision — the caller passes a socket-derived address. */
export async function authorizeRequest(o: AuthGateOptions, now: number = Date.now()): Promise<AuthGateResult> {
  const remoteClass = classifyRemoteAddress(o.remoteAddress);
  const bindExposed = !isLoopbackBind(o.bindHostname);

  if (o.root && o.token) {
    const file = await readDevices(o.root, now);
    if (findApprovedDeviceId(file, o.token)) return { ok: true, via: "token", remoteClass, bindExposed };
  }
  if (remoteClass === "loopback" && (!bindExposed || o.trustLoopbackWhenExposed === true)) {
    return { ok: true, via: "loopback", remoteClass, bindExposed };
  }
  return { ok: false, via: "denied", remoteClass, bindExposed };
}

/** True for the pre-auth device-auth endpoints, which must bypass the gate (they authenticate the
 *  device itself). Everything else under `/api/*` is gated. */
export function isPreAuthApiPath(pathname: string): boolean {
  return /^\/api\/auth\/device\/(start|status|verify|bootstrap)\/?$/.test(pathname);
}

/** A single-line, SECRET-FREE summary of a gate decision for the server log (no token, code, or
 *  Authorization). The raw remote IP is included (it's the operator's own infra) so the funnel
 *  topology can be validated — design §6 Open Q 6A. */
export function gateLogLine(
  route: string,
  r: AuthGateResult,
  remoteAddress: string | undefined,
  bindHostname: string | undefined,
): string {
  const bind = `${bindHostname ?? "127.0.0.1"}(${r.bindExposed ? "exposed" : "loopback"})`;
  return `[auth] ${r.ok ? "allow" : "DENY"} ${route} via=${r.via} remote=${remoteAddress ?? "?"}(${r.remoteClass}) bind=${bind}`;
}

// Crockford-ish base32 without ambiguous glyphs (no I/L/O/U, no 0/1) — a short code a human reads
// aloud / types from another screen. This is a DISPLAY code, not a secret (the secret is the token).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
function newDeviceCode(): string {
  const bytes = randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

/** Issue a device code + dormant bearer token, recording a pending entry. Idempotent for a client
 *  that re-presents a token still tied to a live pending entry (a reload mid-wait must not litter the
 *  store with new pending codes). The token is dormant until the operator approves it via the CLI. */
export async function deviceStart(
  root: string,
  opts: { existingToken?: string; userAgentClass?: string; remoteHint?: string } = {},
  now: number = Date.now(),
): Promise<DeviceStartResult> {
  if (opts.existingToken) {
    const file = await readDevices(root, now);
    for (const [code, p] of Object.entries(file.pending)) {
      if (verifyTokenHash(opts.existingToken, p.tokenHash)) {
        return { code, deviceId: p.deviceId, token: opts.existingToken, pollAfterMs: DEVICE_POLL_AFTER_MS };
      }
    }
    // An approved/revoked/unknown token gets a fresh pending below — `start` is only reached from the
    // unauthorized page, and verify (not start) is the approved path.
  }

  const token = generateToken();
  const deviceId = newDeviceId();
  let code = "";
  await updateDevices(
    root,
    (f) => {
      do {
        code = newDeviceCode();
      } while (f.pending[code]); // avoid a (rare) collision with a live code
      f.pending[code] = {
        deviceId,
        tokenHash: hashToken(token),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PENDING_TTL_MS).toISOString(),
        ...(opts.userAgentClass ? { userAgentClass: opts.userAgentClass } : {}),
        ...(opts.remoteHint ? { remoteHint: opts.remoteHint } : {}),
      };
    },
    now,
  );
  return { code, deviceId, token, pollAfterMs: DEVICE_POLL_AFTER_MS };
}

/** The current status of the device that holds `token`. Scans the whole store (no token-position
 *  timing leak via the constant-time hash compare in the store helpers). */
export async function deviceStatus(
  root: string,
  token: string | undefined,
  now: number = Date.now(),
): Promise<DeviceAuthStatus> {
  if (!token) return "unknown";
  const file = await readDevices(root, now);
  if (findApprovedDeviceId(file, token)) return "approved";
  for (const rec of Object.values(file.devices)) {
    if (rec.status === "revoked" && verifyTokenHash(token, rec.tokenHash)) return "revoked";
  }
  for (const p of Object.values(file.pending)) {
    if (verifyTokenHash(token, p.tokenHash)) return "pending";
  }
  return "unknown";
}

/** Boot-time gate: is `token` an APPROVED device? Pure — it never issues a token, consumes a
 *  bootstrap token, or mutates the store. The bootstrap token is NOT a device credential and never
 *  passes here (it goes through `deviceBootstrap`). */
export async function deviceVerify(
  root: string,
  token: string | undefined,
  now: number = Date.now(),
): Promise<{ ok: boolean }> {
  if (!token) return { ok: false };
  const file = await readDevices(root, now);
  return { ok: Boolean(findApprovedDeviceId(file, token)) };
}

/** First-device bootstrap (design §6). The client presents its DORMANT device token (from `start`,
 *  held in localStorage) as the bearer plus the one-time `bootstrapToken` (from the host log). In a
 *  single locked read-modify-write we re-check the bootstrap token is live, find the pending device
 *  by the dormant token's hash, consume the bootstrap token, and flip that pending device → approved
 *  (the bootstrap token itself never becomes a device credential — it stays short-TTL + single-use,
 *  since it appears in stdout/backend.log). Every failure mode collapses to a single `{ok:false}` so
 *  the caller can return an undifferentiated 401 (no probing which part was wrong). */
export async function deviceBootstrap(
  root: string,
  dormantToken: string | undefined,
  bootstrapToken: string | undefined,
  now: number = Date.now(),
): Promise<{ ok: boolean }> {
  if (!dormantToken || !bootstrapToken) return { ok: false };
  let approved = false;
  await updateDevices(
    root,
    (f: DevicesFile) => {
      if (!bootstrapTokenValid(f, bootstrapToken, now)) return; // re-checked under the lock
      let matchedCode: string | undefined;
      for (const [code, p] of Object.entries(f.pending)) {
        if (verifyTokenHash(dormantToken, p.tokenHash)) {
          matchedCode = code;
          break;
        }
      }
      if (!matchedCode) return; // dormant token has no live pending device → nothing to approve
      const pend = f.pending[matchedCode];
      if (f.bootstrap) f.bootstrap.consumedAt = new Date(now).toISOString(); // one-time
      f.devices[pend.deviceId] = {
        label: "bootstrap",
        status: "approved",
        tokenHash: pend.tokenHash, // the DORMANT device token's hash, never the bootstrap token's
        createdAt: pend.createdAt,
        approvedAt: new Date(now).toISOString(),
      };
      delete f.pending[matchedCode];
      approved = true;
    },
    now,
  );
  return { ok: approved };
}
