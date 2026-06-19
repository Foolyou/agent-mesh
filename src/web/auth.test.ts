// Device-auth backend endpoints (design: docs/design/device-auth.md §4). These drive the real
// handleApi router against a temp <root>/auth store and simulate the CLI approve/revoke step by
// mutating the store directly (the CLI is Phase 2; the backend is a reader/consumer here).
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, type ApiRequestContext } from "./api";
import { readDevices, updateDevices, type DevicesFile } from "../auth-store";
import { generateToken, hashToken } from "../auth-codes";

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
