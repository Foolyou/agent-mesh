import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebGateway } from "./gateway";
import { startWebServer } from "./server";
import { readDevices, updateDevices, type DevicesFile } from "../auth-store";
import { generateToken, hashToken } from "../auth-codes";
import { resolveRoot } from "../root";
import type { MeshConfig, MeshEvent } from "../acp/types";

const CFG: MeshConfig = {
  name: "demo",
  agents: [{ id: "router", harness: "claude", project: "p", role: "router" }],
  edges: [],
};

function fakeManager() {
  return {
    on(_l: (n: string, e: MeshEvent) => void) {
      return () => {};
    },
    listMeshes() {
      return [{ name: "demo", defined: true, status: "stopped" as const }];
    },
    configOf() {
      return CFG;
    },
    routerOf() {
      return "router";
    },
    async startMesh() {},
    async stopMesh() {},
    async promptRouter() {},
    promptAgent() {},
    steerAgent() {},
    resolvePermission() {},
    async setMode() {},
    async setModel() {},
    async setAgentEffort() {},
    async addEdge() {},
    async addAgent() {},
    interruptAgent() {},
    wakeAgent() {},
    stopAgent() {},
    async newAgentSession() {},
    async newAllSessions() {},
    async defineMesh() {},
    async deleteMesh() {},
    async loadDefinitions() {},
    async stopAll() {},
  };
}

// A tmp auth root pre-seeded with one approved device token (the CLI approve step is Phase 2).
async function approvedRoot(): Promise<{ root: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "mesh-server-auth-"));
  const token = generateToken();
  await updateDevices(root, (f: DevicesFile) => {
    f.devices["dv_test"] = {
      status: "approved",
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    };
  });
  return { root, token };
}

test("exposed bind: non-device /api + /ws require auth; loopback is NOT implicitly trusted", async () => {
  const { root, token } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startWebServer({ gateway: gw, port: 0, dev: false, hostname: "0.0.0.0" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // No token: denied even though the socket is loopback, because the bind is exposed.
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    // A spoofed X-Forwarded-For claiming loopback cannot bypass — the gate uses the socket, not headers.
    expect((await fetch(`${base}/api/state`, { headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(401);
    // An approved device token passes via Authorization: Bearer.
    expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    // ...but a `?token=` query is REJECTED for /api/* (URL tokens leak via history/logs/referrers);
    // that transport is reserved for /ws only.
    expect((await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`)).status).toBe(401);
    // Device-auth endpoints stay pre-auth (reachable without a token even on an exposed bind).
    expect((await fetch(`${base}/api/auth/device/start`, { method: "POST" })).status).toBe(200);
    // WS upgrade is gated BEFORE the protocol upgrade: denied → 401; allowed → 400 (upgrade-without-headers).
    expect((await fetch(`${base}/ws`)).status).toBe(401);
    expect((await fetch(`${base}/ws?token=${encodeURIComponent(token)}`)).status).toBe(400);
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("loopback bind implicitly trusts loopback without a token", async () => {
  const { root } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startWebServer({ gateway: gw, port: 0, dev: false, hostname: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/state`)).status).toBe(200); // implicit loopback trust
    expect((await fetch(`${base}/ws`)).status).toBe(400); // gate passes → upgrade-without-headers
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("trustLoopbackWhenExposed override re-enables loopback trust on an exposed bind", async () => {
  const { root } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startWebServer({ gateway: gw, port: 0, dev: false, hostname: "0.0.0.0", trustLoopbackWhenExposed: true });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/state`)).status).toBe(200);
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("WS upgrade succeeds end-to-end for an allowed (loopback) request", async () => {
  const { root } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startWebServer({ gateway: gw, port: 0, dev: false });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });
    expect(opened).toBe(true);
    ws.close();
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("proxy mode handles device-auth at the web tier → remoteHint is the TRUE browser origin", async () => {
  // The web tier is where the browser socket terminates, so device-auth must be served here (not
  // forwarded to the backend, whose only socket view would be the loopback web→backend hop).
  const baseDir = await mkdtemp(join(tmpdir(), "mesh-proxy-root-"));
  const prev = process.env.MESH_ROOT;
  process.env.MESH_ROOT = baseDir; // the proxy web tier resolves its auth root via resolveRoot()
  // exposed bind + loopback socket → the web tier should classify the device as "exposed-loopback".
  const server = startWebServer({ backendUrl: "http://127.0.0.1:1", port: 0, dev: false, hostname: "0.0.0.0" });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const r = await fetch(`${origin}/api/auth/device/start`, { method: "POST" });
    expect(r.status).toBe(200); // handled locally; the dead backendUrl is never contacted
    const body = await r.json();
    const file = await readDevices(resolveRoot([], { MESH_ROOT: baseDir } as any));
    expect(file.pending[body.code].remoteHint).toBe("exposed-loopback"); // web-tier view, NOT backend loopback
  } finally {
    server.stop();
    if (prev === undefined) delete process.env.MESH_ROOT;
    else process.env.MESH_ROOT = prev;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("SPA shell routes are served with no-store cache headers", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const server = startWebServer({ gateway: gw, port: 0, dev: false });
  try {
    for (const path of ["/", "/mesh/demo"]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store, max-age=0, must-revalidate");
      if (path === "/") {
        const html = await res.text();
        const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
        expect(script).toBeString();
        const scriptRes = await fetch(`${server.url}${script}`);
        expect(scriptRes.status).toBe(200);
        expect(scriptRes.headers.get("content-type") ?? "").toContain("javascript");
      }
    }
  } finally {
    server.stop();
  }
});
