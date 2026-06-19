// Client-side device token (design device-auth.md §4). The token is a bearer secret stored in
// localStorage; it is sent on EVERY /api/* request as `Authorization: Bearer <token>` — never in a
// URL (URLs leak via history / logs / referrers). The ONLY URL-token transport is the /ws query
// param, because the browser WebSocket client can't set request headers.

const TOKEN_KEY = "mesh.deviceToken";

export function getDeviceToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) || undefined;
  } catch {
    return undefined; // no localStorage (SSR / sandboxed) → treated as unauthenticated
  }
}

export function setDeviceToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* unavailable */
  }
}

export function clearDeviceToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* unavailable */
  }
}

/** Headers for an /api/* fetch: the bearer token (if any) merged onto `extra`. Bearer ONLY — this
 *  function never produces a URL token. */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getDeviceToken();
  return { ...(extra ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** The /ws URL with the device token as the query param (the only sanctioned URL-token transport). */
export function wsUrlWithToken(proto: string, host: string, token: string | undefined): string {
  const base = `${proto}://${host}/ws`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export type DeviceAuthPhase = "pending" | "approved" | "revoked" | "unknown";

export interface DeviceStartInfo {
  code: string;
  pollAfterMs: number;
}

type FetchFn = typeof fetch;
const DEFAULT_POLL_MS = 2500;

/** Boot gate: probe a REAL gated endpoint (`GET /api/state`) so the client honours the SAME server
 *  gate as everything else — it sends the bearer token if we have one (the approved-device path) and
 *  still succeeds with no token when the server grants loopback-only implicit trust (the dev / host
 *  bootstrap path). 200 → authorized; 401 / network error → show the unauthorized page. This
 *  deliberately does NOT rely on `POST /api/auth/device/verify`, which only knows about device
 *  tokens and would wrongly reject an authorized loopback session that has no token. */
export async function bootAuthorized(fetchFn: FetchFn = fetch): Promise<boolean> {
  try {
    const res = await fetchFn("/api/state", { headers: authHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

/** Begin enrollment: the server issues a device code + a dormant token; we persist the token (for
 *  polling + later use) and return the code to display + the poll cadence. */
export async function startDevice(fetchFn: FetchFn = fetch): Promise<DeviceStartInfo> {
  const res = await fetchFn("/api/auth/device/start", { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error("device start failed");
  const json: any = await res.json().catch(() => ({}));
  if (typeof json?.token === "string") setDeviceToken(json.token);
  const pollAfterMs = Number(json?.pollAfterMs);
  return { code: String(json?.code ?? ""), pollAfterMs: Number.isFinite(pollAfterMs) && pollAfterMs > 0 ? pollAfterMs : DEFAULT_POLL_MS };
}

/** Poll the stored token's status. A non-OK response or unrecognized payload → "unknown". */
export async function pollDeviceStatus(fetchFn: FetchFn = fetch): Promise<DeviceAuthPhase> {
  try {
    const res = await fetchFn("/api/auth/device/status", { headers: authHeaders() });
    if (!res.ok) return "unknown";
    const json: any = await res.json().catch(() => ({}));
    const s = json?.status;
    return s === "approved" || s === "pending" || s === "revoked" ? s : "unknown";
  } catch {
    return "unknown";
  }
}

/** First-device bootstrap (design §6): send the operator's one-time bootstrap token (from the host
 *  log) to consume it and approve THIS device. The bearer is our DORMANT device token (from start,
 *  in localStorage); the bootstrap token travels only in the request body — it is never persisted
 *  and never put in a URL. Returns true on success; any failure → false (the caller shows a generic
 *  message, never an internal reason). */
export async function submitBootstrap(bootstrapToken: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  try {
    const res = await fetchFn("/api/auth/device/bootstrap", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ bootstrapToken }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface EnrollmentHandlers {
  onCode?: (code: string) => void;
  onStatus?: (status: DeviceAuthPhase) => void;
}
export type EnrollmentOutcome = "approved" | "revoked" | "unknown" | "failed" | "cancelled";

/** The unauthorized-page enrollment loop, extracted so it's testable without a DOM. Issues a device
 *  code (reports it via `onCode`), then polls status every `pollAfterMs` until a terminal outcome:
 *  approved (enter the app), or revoked/unknown (the pending lapsed/was rejected — prompt a refresh).
 *  `wait` and `shouldContinue` are injectable so tests run instantly and can simulate unmount. A
 *  start/network failure → "failed". Never throws. */
export async function runEnrollment(
  handlers: EnrollmentHandlers = {},
  fetchFn: FetchFn = fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  shouldContinue: () => boolean = () => true,
): Promise<EnrollmentOutcome> {
  let info: DeviceStartInfo;
  try {
    info = await startDevice(fetchFn);
  } catch {
    return "failed";
  }
  handlers.onCode?.(info.code);
  for (;;) {
    if (!shouldContinue()) return "cancelled";
    await wait(info.pollAfterMs);
    if (!shouldContinue()) return "cancelled";
    const status = await pollDeviceStatus(fetchFn);
    handlers.onStatus?.(status);
    if (status === "approved") return "approved";
    if (status === "revoked") return "revoked";
    if (status === "unknown") return "unknown"; // pending lapsed / expired → stop, prompt refresh
    // pending → keep polling
  }
}
