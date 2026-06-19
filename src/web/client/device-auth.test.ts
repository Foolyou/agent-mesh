// Client device-token plumbing (commit 3). Verifies the hard requirement: /api/* uses Bearer ONLY
// (never a URL token), and /ws is the only URL-token transport.
import { test, expect, beforeEach } from "bun:test";
import {
  authHeaders,
  bootAuthorized,
  clearDeviceToken,
  getDeviceToken,
  pollDeviceStatus,
  runEnrollment,
  setDeviceToken,
  startDevice,
  submitBootstrap,
  wsUrlWithToken,
} from "./device-auth";

// In-memory localStorage stub (Bun's test runtime has no DOM).
class MemStore {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
beforeEach(() => {
  (globalThis as any).localStorage = new MemStore();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("token storage round-trips through localStorage", () => {
  expect(getDeviceToken()).toBeUndefined();
  setDeviceToken("tok-123");
  expect(getDeviceToken()).toBe("tok-123");
  clearDeviceToken();
  expect(getDeviceToken()).toBeUndefined();
});

test("authHeaders adds Bearer only when a token exists, merging extra headers", () => {
  expect(authHeaders()).toEqual({});
  expect(authHeaders({ "content-type": "application/json" })).toEqual({ "content-type": "application/json" });
  setDeviceToken("tok-abc");
  expect(authHeaders()).toEqual({ Authorization: "Bearer tok-abc" });
  expect(authHeaders({ "content-type": "application/json" })).toEqual({ "content-type": "application/json", Authorization: "Bearer tok-abc" });
});

test("wsUrlWithToken puts the token in the query (only sanctioned URL transport)", () => {
  expect(wsUrlWithToken("wss", "host:1", undefined)).toBe("wss://host:1/ws");
  expect(wsUrlWithToken("ws", "h", "a/b c")).toBe("ws://h/ws?token=a%2Fb%20c");
});

test("bootAuthorized probes the real gate (GET /api/state) with Bearer-if-present, no URL token", async () => {
  // No token + 200 → server granted loopback-only implicit trust → authorized (dev/host bootstrap).
  const calls: Array<{ url: string; init: any }> = [];
  const ok200 = ((url: string, init: any) => {
    calls.push({ url, init });
    return Promise.resolve(jsonResponse({ meshes: [] }));
  }) as any;
  expect(await bootAuthorized(ok200)).toBe(true);
  expect(calls[0].url).toBe("/api/state");
  expect(calls[0].url).not.toContain("token=");
  expect(calls[0].init.headers).toEqual({}); // no token → no Authorization

  // With a token, the probe carries Bearer (the approved-device path).
  setDeviceToken("tok-b");
  const calls2: Array<{ url: string; init: any }> = [];
  await bootAuthorized(((url: string, init: any) => {
    calls2.push({ url, init });
    return Promise.resolve(jsonResponse({ meshes: [] }));
  }) as any);
  expect(calls2[0].init.headers).toEqual({ Authorization: "Bearer tok-b" });
  expect(calls2[0].url).not.toContain("token=");

  // 401 → unauthorized; network error → unauthorized.
  expect(await bootAuthorized((() => Promise.resolve(jsonResponse({}, 401))) as any)).toBe(false);
  expect(await bootAuthorized((() => Promise.reject(new Error("net"))) as any)).toBe(false);
});

test("runEnrollment shows the code then resolves approved once status flips", async () => {
  const statuses = ["pending", "pending", "approved"];
  const fetchMock = ((url: string) => {
    if (url === "/api/auth/device/start") return Promise.resolve(jsonResponse({ code: "K7Q-3F9", token: "tok-e", pollAfterMs: 5 }));
    return Promise.resolve(jsonResponse({ status: statuses.shift() ?? "approved" }));
  }) as any;
  const seenCodes: string[] = [];
  const seenStatuses: string[] = [];
  const outcome = await runEnrollment(
    { onCode: (c) => seenCodes.push(c), onStatus: (s) => seenStatuses.push(s) },
    fetchMock,
    () => Promise.resolve(), // instant wait
  );
  expect(outcome).toBe("approved");
  expect(seenCodes).toEqual(["K7Q-3F9"]);
  expect(seenStatuses).toEqual(["pending", "pending", "approved"]);
  expect(getDeviceToken()).toBe("tok-e"); // dormant token persisted by startDevice
});

test("runEnrollment resolves revoked/unknown without looping forever, and failed on start error", async () => {
  const revoked = ((url: string) =>
    url === "/api/auth/device/start"
      ? Promise.resolve(jsonResponse({ code: "C", token: "t", pollAfterMs: 1 }))
      : Promise.resolve(jsonResponse({ status: "revoked" }))) as any;
  expect(await runEnrollment({}, revoked, () => Promise.resolve())).toBe("revoked");

  const lapsed = ((url: string) =>
    url === "/api/auth/device/start"
      ? Promise.resolve(jsonResponse({ code: "C", token: "t", pollAfterMs: 1 }))
      : Promise.resolve(jsonResponse({ status: "weird" }))) as any; // unrecognized → unknown
  expect(await runEnrollment({}, lapsed, () => Promise.resolve())).toBe("unknown");

  const startFails = (() => Promise.resolve(jsonResponse({}, 500))) as any;
  expect(await runEnrollment({}, startFails, () => Promise.resolve())).toBe("failed");
});

test("submitBootstrap sends Bearer dormant token + body token, never URL/persists the bootstrap token", async () => {
  setDeviceToken("dormant-tok"); // the device's own token from start()
  const calls: Array<{ url: string; init: any }> = [];
  const fetchMock = ((url: string, init: any) => {
    calls.push({ url, init });
    return Promise.resolve(jsonResponse({ ok: true }));
  }) as any;

  expect(await submitBootstrap("BOOT-1time", fetchMock)).toBe(true);
  const { url, init } = calls[0];
  expect(url).toBe("/api/auth/device/bootstrap");
  expect(url).not.toContain("token="); // never in the URL
  expect(init.method).toBe("POST");
  expect(init.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer dormant-tok" });
  expect(JSON.parse(init.body)).toEqual({ bootstrapToken: "BOOT-1time" }); // travels in the body only
  // the bootstrap token is NOT persisted; the stored device token is untouched (submitBootstrap
  // never calls setDeviceToken — the one-time bootstrap token lives only in this request body).
  expect(getDeviceToken()).toBe("dormant-tok");
});

test("submitBootstrap returns false generically on 401 and on network error", async () => {
  setDeviceToken("dormant-tok");
  expect(await submitBootstrap("x", (() => Promise.resolve(jsonResponse({ error: { message: "unauthorized" } }, 401))) as any)).toBe(false);
  expect(await submitBootstrap("x", (() => Promise.reject(new Error("net"))) as any)).toBe(false);
});

test("runEnrollment stops when shouldContinue turns false (unmount)", async () => {
  let polls = 0;
  const fetchMock = ((url: string) => {
    if (url === "/api/auth/device/start") return Promise.resolve(jsonResponse({ code: "C", token: "t", pollAfterMs: 1 }));
    polls++;
    return Promise.resolve(jsonResponse({ status: "pending" }));
  }) as any;
  let live = true;
  const p = runEnrollment({}, fetchMock, () => Promise.resolve(), () => live);
  live = false; // simulate unmount before the first poll wait resolves
  expect(await p).toBe("cancelled");
  expect(polls).toBe(0);
});

test("startDevice persists the returned token and returns code + poll cadence", async () => {
  const fetchMock = (() => Promise.resolve(jsonResponse({ code: "K7Q-3F9", deviceId: "dv_x", token: "tok-new", pollAfterMs: 3000 }))) as any;
  const info = await startDevice(fetchMock);
  expect(info).toEqual({ code: "K7Q-3F9", pollAfterMs: 3000 });
  expect(getDeviceToken()).toBe("tok-new"); // stored for polling + later use
});

test("startDevice defaults pollAfterMs when the server omits/garbles it", async () => {
  const fetchMock = (() => Promise.resolve(jsonResponse({ code: "ABC-DEF", token: "t" }))) as any;
  expect((await startDevice(fetchMock)).pollAfterMs).toBe(2500);
});

test("pollDeviceStatus maps known statuses and falls back to unknown", async () => {
  setDeviceToken("tok-p");
  for (const s of ["pending", "approved", "revoked"]) {
    const r = await pollDeviceStatus((() => Promise.resolve(jsonResponse({ status: s }))) as any);
    expect(r).toBe(s as any);
  }
  expect(await pollDeviceStatus((() => Promise.resolve(jsonResponse({ status: "weird" }))) as any)).toBe("unknown");
  expect(await pollDeviceStatus((() => Promise.resolve(jsonResponse({}, 500))) as any)).toBe("unknown");
  expect(await pollDeviceStatus((() => Promise.reject(new Error("net"))) as any)).toBe("unknown");
});

test("pollDeviceStatus sends Bearer header and never a URL token", async () => {
  setDeviceToken("tok-q");
  const calls: Array<{ url: string; init: any }> = [];
  const fetchMock = ((url: string, init: any) => {
    calls.push({ url, init });
    return Promise.resolve(jsonResponse({ status: "pending" }));
  }) as any;
  await pollDeviceStatus(fetchMock);
  expect(calls[0].url).toBe("/api/auth/device/status");
  expect(calls[0].url).not.toContain("token=");
  expect(calls[0].init.headers).toEqual({ Authorization: "Bearer tok-q" });
});
