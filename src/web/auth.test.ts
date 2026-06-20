// Device-auth backend endpoints (design: docs/design/device-auth.md §4). These drive the real
// handleApi router against a temp <root>/auth store and simulate the CLI approve/revoke step by
// mutating the store directly (the CLI is Phase 2; the backend is a reader/consumer here).
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, type ApiRequestContext } from "./api";
import { authorizeRequest, classifyRemoteAddress, isPreAuthApiPath, isLifecycleRoute } from "./auth";
import { readDevices, updateDevices, type DevicesFile } from "../auth-store";
import { generateToken, hashToken } from "../auth-codes";
import { signHostBearer } from "../cli-host-bearer";

// The device routes never touch the gateway, so a bare stub is enough.
const gw = {} as any;

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mesh-auth-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ctxFor = (root: string, headers?: Record<string, string>): ApiRequestContext => ({
  root,
  headers: headers ? new Headers(headers) : undefined,
});
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const start = (root: string, headers?: Record<string, string>) =>
  handleApi(gw, "POST", "/api/auth/device/start", {}, new URLSearchParams(), undefined, undefined, undefined, ctxFor(root, headers));
const status = (root: string, token?: string) =>
  handleApi(gw, "GET", "/api/auth/device/status", undefined, new URLSearchParams(), undefined, undefined, undefined, ctxFor(root, token ? bearer(token) : undefined));
const verify = (root: string, token?: string) =>
  handleApi(gw, "POST", "/api/auth/device/verify", {}, new URLSearchParams(), undefined, undefined, undefined, ctxFor(root, token ? bearer(token) : undefined));
const bootstrap = (root: string, dormantToken: string | undefined, bootstrapToken: unknown) =>
  handleApi(gw, "POST", "/api/auth/device/bootstrap", { bootstrapToken }, new URLSearchParams(), undefined, undefined, undefined, ctxFor(root, dormantToken ? bearer(dormantToken) : undefined));

async function seedBootstrap(root: string, token: string, opts: { ageMs?: number; ttlMs?: number; consumed?: boolean } = {}) {
  const now = Date.now();
  const ttl = opts.ttlMs ?? 10 * 60_000;
  await updateDevices(root, (f: DevicesFile) => {
    f.bootstrap = {
      tokenHash: hashToken(token),
      createdAt: new Date(now - (opts.ageMs ?? 0)).toISOString(),
      expiresAt: new Date(now - (opts.ageMs ?? 0) + ttl).toISOString(),
      ...(opts.consumed ? { consumedAt: new Date(now).toISOString() } : {}),
    };
  });
}

test("POST /api/auth/device/start issues a code + deviceId + token and writes ONE pending entry", async () => {
  await withRoot(async (root) => {
    const r = await start(root, { "user-agent": "Mozilla/5.0 (Macintosh)" });
    expect(r.status).toBe(200);
    expect(typeof r.body.code).toBe("string");
    expect(r.body.code.length).toBeGreaterThanOrEqual(5);
    expect(typeof r.body.deviceId).toBe("string");
    expect(r.body.deviceId.startsWith("dv_")).toBe(true);
    expect(typeof r.body.token).toBe("string");
    expect(r.body.token.length).toBeGreaterThan(20);
    expect(r.body.pollAfterMs).toBeGreaterThan(0);

    const file = await readDevices(root);
    const codes = Object.keys(file.pending);
    expect(codes).toEqual([r.body.code]);
    const pend = file.pending[r.body.code];
    expect(pend.deviceId).toBe(r.body.deviceId);
    expect(pend.tokenHash).toBe(hashToken(r.body.token)); // raw token never stored, only its hash
    expect(pend.userAgentClass).toBe("desktop"); // coarse, non-PII
    expect(Object.keys(file.devices)).toHaveLength(0); // dormant until approved
  });
});

test("GET status reports pending → approved after the store is mutated (CLI approve)", async () => {
  await withRoot(async (root) => {
    const issued = (await start(root)).body;
    expect((await status(root, issued.token)).body.status).toBe("pending");
    expect((await verify(root, issued.token)).status).toBe(401); // dormant token can't enter yet

    // simulate `mesh device approve <code>`: move pending → devices approved.
    await updateDevices(root, (f: DevicesFile) => {
      const pend = f.pending[issued.code];
      delete f.pending[issued.code];
      f.devices[pend.deviceId] = {
        status: "approved",
        tokenHash: pend.tokenHash,
        createdAt: pend.createdAt,
        approvedAt: new Date().toISOString(),
      };
    });

    expect((await status(root, issued.token)).body.status).toBe("approved");
    const v = await verify(root, issued.token);
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ ok: true });
  });
});

test("revoked device is rejected by status + verify", async () => {
  await withRoot(async (root) => {
    const issued = (await start(root)).body;
    await updateDevices(root, (f: DevicesFile) => {
      const pend = f.pending[issued.code];
      delete f.pending[issued.code];
      f.devices[pend.deviceId] = { status: "revoked", tokenHash: pend.tokenHash, createdAt: pend.createdAt };
    });
    expect((await status(root, issued.token)).body.status).toBe("revoked");
    expect((await verify(root, issued.token)).status).toBe(401);
  });
});

test("status/verify with no token or an unknown token do not leak state", async () => {
  await withRoot(async (root) => {
    expect((await status(root)).body.status).toBe("unknown");
    expect((await status(root, "not-a-real-token")).body.status).toBe("unknown");
    expect((await verify(root)).status).toBe(401);
    expect((await verify(root, "not-a-real-token")).status).toBe(401);
  });
});

test("start is idempotent for a client re-presenting its still-pending token (no second pending)", async () => {
  await withRoot(async (root) => {
    const first = (await start(root)).body;
    const second = (await start(root, bearer(first.token))).body;
    expect(second.code).toBe(first.code);
    expect(second.deviceId).toBe(first.deviceId);
    const file = await readDevices(root);
    expect(Object.keys(file.pending)).toHaveLength(1);
  });
});

test("bootstrap flips the DORMANT device to approved and consumes the bootstrap token", async () => {
  await withRoot(async (root) => {
    const issued = (await start(root)).body; // dormant device token + pending code
    const bootToken = generateToken();
    await seedBootstrap(root, bootToken);

    const b = await bootstrap(root, issued.token, bootToken);
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ ok: true });

    const after = await readDevices(root);
    expect(after.bootstrap?.consumedAt).toBeTruthy(); // one-time consume
    expect(Object.keys(after.pending)).toHaveLength(0); // pending code dropped
    const dev = after.devices[issued.deviceId];
    expect(dev?.status).toBe("approved");
    expect(dev?.tokenHash).toBe(hashToken(issued.token)); // dormant device token, NOT the bootstrap token

    // the dormant token now verifies; status is approved.
    expect((await verify(root, issued.token)).status).toBe(200);
    expect((await status(root, issued.token)).body.status).toBe("approved");

    // the bootstrap token itself is NOT a device credential and never became approved.
    expect((await verify(root, bootToken)).status).toBe(401);
    expect((await status(root, bootToken)).body.status).toBe("unknown");
  });
});

test("a consumed bootstrap token cannot be replayed", async () => {
  await withRoot(async (root) => {
    const first = (await start(root)).body;
    const second = (await start(root)).body; // a different dormant device
    const bootToken = generateToken();
    await seedBootstrap(root, bootToken);

    expect((await bootstrap(root, first.token, bootToken)).status).toBe(200);
    // bootstrap already consumed → a second device cannot ride the same token.
    expect((await bootstrap(root, second.token, bootToken)).status).toBe(401);
    expect((await status(root, second.token)).body.status).toBe("pending");
  });
});

test("every bootstrap failure mode is an undifferentiated 401", async () => {
  await withRoot(async (root) => {
    const issued = (await start(root)).body;
    const good = generateToken();

    // wrong bootstrap token (no bootstrap seeded yet)
    expect((await bootstrap(root, issued.token, "wrong")).status).toBe(401);

    // expired bootstrap
    await seedBootstrap(root, good, { ageMs: 20 * 60_000, ttlMs: 60_000 });
    expect((await bootstrap(root, issued.token, good)).status).toBe(401);

    // consumed bootstrap
    await seedBootstrap(root, good, { consumed: true });
    expect((await bootstrap(root, issued.token, good)).status).toBe(401);

    // live bootstrap but wrong / missing dormant token (no matching pending device)
    await seedBootstrap(root, good);
    expect((await bootstrap(root, "not-a-device-token", good)).status).toBe(401);
    expect((await bootstrap(root, undefined, good)).status).toBe(401);

    // live bootstrap, valid dormant token, but missing bootstrapToken in the body
    expect((await bootstrap(root, issued.token, undefined)).status).toBe(401);

    // nothing above should have approved anyone or consumed the live token
    const file = await readDevices(root);
    expect(Object.keys(file.devices)).toHaveLength(0);
    expect(file.bootstrap?.consumedAt).toBeUndefined();
  });
});

test("device endpoints fail closed when no auth root is configured", async () => {
  for (const path of ["/api/auth/device/start", "/api/auth/device/verify", "/api/auth/device/bootstrap"]) {
    const r = await handleApi(gw, "POST", path, {}, new URLSearchParams(), undefined, undefined, undefined, {});
    expect(r.status).toBe(500);
  }
});

// ── request gate (phase 6: unconditional device-token enforcement) ───────────────────────────

test("classifyRemoteAddress labels loopback (diagnostic only — no longer a trust signal)", () => {
  for (const a of ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1", "[::1]", "::1%lo0", " 127.0.0.1 "])
    expect(classifyRemoteAddress(a)).toBe("loopback");
  for (const a of ["10.0.0.4", "203.0.113.9", "192.168.1.5", "::ffff:8.8.8.8", "fe80::1", "100.115.92.3"])
    expect(classifyRemoteAddress(a)).toBe("remote");
  expect(classifyRemoteAddress(undefined)).toBe("remote");
  expect(classifyRemoteAddress("")).toBe("remote");
});

test("authorizeRequest: an approved device token is the ONLY allow path", async () => {
  await withRoot(async (root) => {
    const issued = (await start(root)).body;
    await updateDevices(root, (f: DevicesFile) => {
      const pend = f.pending[issued.code];
      delete f.pending[issued.code];
      f.devices[pend.deviceId] = { status: "approved", tokenHash: pend.tokenHash, createdAt: pend.createdAt, approvedAt: new Date().toISOString() };
    });
    // Approved token passes regardless of the remote address (loopback or not).
    for (const remoteAddress of ["127.0.0.1", "203.0.113.9"]) {
      const r = await authorizeRequest({ root, token: issued.token, remoteAddress });
      expect(r).toMatchObject({ ok: true, via: "token" });
    }
    // A bogus token is denied even from loopback.
    const bogus = await authorizeRequest({ root, token: "bogus", remoteAddress: "127.0.0.1" });
    expect(bogus).toMatchObject({ ok: false, via: "denied" });
  });
});

test("authorizeRequest: loopback is NEVER trusted without a token (funnel makes remote look loopback)", async () => {
  await withRoot(async (root) => {
    for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "203.0.113.9"]) {
      const r = await authorizeRequest({ root, token: undefined, remoteAddress });
      expect(r).toMatchObject({ ok: false, via: "denied" });
    }
  });
});

test("authorizeRequest fails closed with no root (no device store to validate against)", async () => {
  const r = await authorizeRequest({ root: undefined, token: "anything", remoteAddress: "127.0.0.1" });
  expect(r).toMatchObject({ ok: false, via: "denied" });
});

test("authorizeRequest result carries no bind/loopback trust fields (only token/denied)", async () => {
  await withRoot(async (root) => {
    const r = await authorizeRequest({ root, token: undefined, remoteAddress: "127.0.0.1" });
    expect(["token", "denied"]).toContain(r.via);
    expect(r).not.toHaveProperty("bindExposed");
  });
});

// ── host-key bearer gate (mesh-cli-lifecycle §A Approach 2) ──

test("isLifecycleRoute whitelists ONLY GET /api/meshes and POST .../start|stop", () => {
  expect(isLifecycleRoute("GET", "/api/meshes")).toBe(true);
  expect(isLifecycleRoute("POST", "/api/meshes/demo/start")).toBe(true);
  expect(isLifecycleRoute("POST", "/api/meshes/demo/stop")).toBe(true);
  // off-whitelist
  for (const [m, p] of [["GET", "/api/state"], ["POST", "/api/meshes/demo/agents"], ["GET", "/api/meshes/demo/config"], ["DELETE", "/api/meshes/demo"], ["POST", "/api/meshes"], ["GET", "/api/meshes/demo/start"]] as const)
    expect(isLifecycleRoute(m, p)).toBe(false);
  expect(isLifecycleRoute(undefined, undefined)).toBe(false);
});

test("authorizeRequest: a valid host-key bearer authorizes the lifecycle routes (via host-key)", async () => {
  await withRoot(async (root) => {
    const token = await signHostBearer(root);
    for (const [method, path] of [["GET", "/api/meshes"], ["POST", "/api/meshes/demo/start"], ["POST", "/api/meshes/demo/stop"]] as const) {
      const r = await authorizeRequest({ root, token, remoteAddress: "127.0.0.1", route: "api", method, path });
      expect(r).toMatchObject({ ok: true, via: "host-key" });
    }
  });
});

test("authorizeRequest: a host-key bearer is DENIED on /ws and on any non-lifecycle /api route", async () => {
  await withRoot(async (root) => {
    const token = await signHostBearer(root);
    const ws = await authorizeRequest({ root, token, remoteAddress: "127.0.0.1", route: "ws", method: "GET", path: "/ws" });
    expect(ws).toMatchObject({ ok: false, via: "denied" });
    for (const [method, path] of [["GET", "/api/state"], ["POST", "/api/meshes/demo/agents"], ["DELETE", "/api/meshes/demo"]] as const) {
      const r = await authorizeRequest({ root, token, remoteAddress: "127.0.0.1", route: "api", method, path });
      expect(r).toMatchObject({ ok: false, via: "denied" });
    }
  });
});

test("authorizeRequest: an expired host-key bearer is denied even on a lifecycle route", async () => {
  await withRoot(async (root) => {
    const past = Date.now() - 120_000;
    const token = await signHostBearer(root, { now: () => past, ttlSeconds: 60 }); // exp = past+60s, already gone
    const r = await authorizeRequest({ root, token, remoteAddress: "127.0.0.1", route: "api", method: "GET", path: "/api/meshes" });
    expect(r).toMatchObject({ ok: false, via: "denied" });
  });
});

test("authorizeRequest: a tampered host-key bearer is denied on a lifecycle route", async () => {
  await withRoot(async (root) => {
    const token = await signHostBearer(root);
    const bad = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA"); // corrupt the mac tail
    const r = await authorizeRequest({ root, token: bad, remoteAddress: "127.0.0.1", route: "api", method: "GET", path: "/api/meshes" });
    expect(r).toMatchObject({ ok: false, via: "denied" });
  });
});

test("authorizeRequest: the device-token path is unchanged — full API + ws, ignoring method/path", async () => {
  await withRoot(async (root) => {
    const token = generateToken();
    await updateDevices(root, (f: DevicesFile) => {
      f.devices["dv_x"] = { status: "approved", tokenHash: hashToken(token), createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() };
    });
    const api = await authorizeRequest({ root, token, remoteAddress: "127.0.0.1", route: "api", method: "GET", path: "/api/state" });
    expect(api).toMatchObject({ ok: true, via: "token" }); // a device token reaches a NON-lifecycle route
    const ws = await authorizeRequest({ root, token, remoteAddress: "127.0.0.1", route: "ws", method: "GET", path: "/ws" });
    expect(ws).toMatchObject({ ok: true, via: "token" }); // and /ws
  });
});

test("isPreAuthApiPath matches only the device-auth endpoints", () => {
  for (const p of ["/api/auth/device/start", "/api/auth/device/status", "/api/auth/device/verify", "/api/auth/device/bootstrap"])
    expect(isPreAuthApiPath(p)).toBe(true);
  for (const p of ["/api/state", "/api/auth/device", "/api/auth/device/start/x", "/api/meshes", "/ws", "/api/auth/devices"])
    expect(isPreAuthApiPath(p)).toBe(false);
  // System diagnostics MUST be gated (not pre-auth): an unapproved device must never read ps/doctor.
  for (const p of ["/api/diagnostics/ps", "/api/diagnostics/doctor"])
    expect(isPreAuthApiPath(p)).toBe(false);
});
