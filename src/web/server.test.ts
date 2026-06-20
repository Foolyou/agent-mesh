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

test("loopback bind STILL requires a device token (a loopback socket is never trusted)", async () => {
  // Funnel testing proved remote traffic reaches the service as a loopback socket, so even on a
  // loopback bind a token is the only allow path.
  const { root, token } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startWebServer({ gateway: gw, port: 0, dev: false, hostname: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/state`)).status).toBe(401); // no token → denied (no loopback trust)
    // A spoofed X-Forwarded-For cannot conjure a token; still denied.
    expect((await fetch(`${base}/api/state`, { headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(401);
    // An approved device token passes via Authorization: Bearer.
    expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    // ...but a `?token=` query is REJECTED for /api/* (URL tokens leak); reserved for /ws only.
    expect((await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`)).status).toBe(401);
    // Device-auth endpoints stay pre-auth so first enrollment is possible.
    expect((await fetch(`${base}/api/auth/device/start`, { method: "POST" })).status).toBe(200);
    // WS gated BEFORE upgrade: no token → 401; valid token → 400 (upgrade-without-headers in this fetch).
    expect((await fetch(`${base}/ws`)).status).toBe(401);
    expect((await fetch(`${base}/ws?token=${encodeURIComponent(token)}`)).status).toBe(400);
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("exposed bind enforces identically — token required, no override", async () => {
  const { root, token } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startWebServer({ gateway: gw, port: 0, dev: false, hostname: "0.0.0.0" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${base}/api/auth/device/start`, { method: "POST" })).status).toBe(200); // pre-auth
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("WS upgrade succeeds with a valid token and is rejected without one", async () => {
  const { root, token } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startWebServer({ gateway: gw, port: 0, dev: false });
  const open = (url: string) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        resolve(true);
        ws.close();
      };
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });
  try {
    expect(await open(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token)}`)).toBe(true);
    expect(await open(`ws://127.0.0.1:${server.port}/ws`)).toBe(false); // no token → upgrade refused
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
  // The web tier (where the browser socket terminates) records the TRUE browser origin class as a
  // coarse, advisory remoteHint — not the backend's loopback view of the web→backend hop.
  const server = startWebServer({ backendUrl: "http://127.0.0.1:1", port: 0, dev: false, hostname: "0.0.0.0" });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const r = await fetch(`${origin}/api/auth/device/start`, { method: "POST" });
    expect(r.status).toBe(200); // handled locally; the dead backendUrl is never contacted
    const body = await r.json();
    const file = await readDevices(resolveRoot([], { MESH_ROOT: baseDir } as any));
    expect(file.pending[body.code].remoteHint).toBe("loopback"); // web-tier socket view (advisory only)
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
