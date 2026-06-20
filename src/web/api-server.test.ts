// Headless backend gate (device-auth commit 2). Same authoritative gate as the web tier, evaluated
// on the backend's own socket address + bind. Direct-to-backend exposure must require a token; a
// loopback-bound backend implicitly trusts loopback (incl. the same-host proxy hop).
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebGateway } from "./gateway";
import { startApiServer } from "./api-server";
import { updateDevices, type DevicesFile } from "../auth-store";
import { generateToken, hashToken } from "../auth-codes";
import type { MeshConfig, MeshEvent } from "../acp/types";

const CFG: MeshConfig = { name: "demo", agents: [{ id: "router", harness: "claude", project: "p", role: "router" }], edges: [] };

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
    async stopAll() {},
  };
}

async function approvedRoot(): Promise<{ root: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "mesh-apiserver-auth-"));
  const token = generateToken();
  await updateDevices(root, (f: DevicesFile) => {
    f.devices["dv_test"] = { status: "approved", tokenHash: hashToken(token), createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() };
  });
  return { root, token };
}

test("backend on an exposed bind requires a token; loopback is not implicitly trusted", async () => {
  const { root, token } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startApiServer(gw, { port: 0, hostname: "0.0.0.0" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    // `?token=` is NOT a valid /api credential (reserved for /ws) — must stay 401.
    expect((await fetch(`${base}/api/state?token=${encodeURIComponent(token)}`)).status).toBe(401);
    expect((await fetch(`${base}/api/auth/device/start`, { method: "POST" })).status).toBe(200); // pre-auth
    expect((await fetch(`${base}/ws`)).status).toBe(401); // gated before upgrade
    expect((await fetch(`${base}/ws?token=${encodeURIComponent(token)}`)).status).toBe(400); // allowed → upgrade-without-headers
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("loopback-bound backend STILL requires a token (no loopback trust, even same-host)", async () => {
  const { root, token } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startApiServer(gw, { port: 0, hostname: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/state`)).status).toBe(401); // no token → denied
    expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${base}/api/auth/device/start`, { method: "POST" })).status).toBe(200); // pre-auth
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/diagnostics/doctor reports the backend check on THIS server's real port (not 10010)", async () => {
  const { root, token } = await approvedRoot();
  const gw = new WebGateway(fakeManager() as any, undefined, { root });
  const server = startApiServer(gw, { port: 0, hostname: "127.0.0.1" }); // port 0 → OS picks a random port
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const res = await fetch(`${base}/api/diagnostics/doctor`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const report = await res.json();
    const backend = report.checks.find((c: any) => c.id === "service.backend");
    expect(backend).toBeTruthy();
    // the doctor probed the server's actual listening port (threaded via ctx.servicePort = srv.port),
    // and a live server answering /api/state (gated 401 < 500) reads as healthy on that port.
    expect(backend.detail).toContain(`:${server.port}`);
    expect(backend.detail).not.toContain(":10010");
    expect(backend.severity).toBe("ok");
    // secret-free: the whole doctor payload never carries a credential marker
    const blob = JSON.stringify(report);
    expect(blob).not.toContain("sha256:");
    expect(blob).not.toMatch(/Bearer\s/);
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
