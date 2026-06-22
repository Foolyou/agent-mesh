// Integration smoke for the web server: boots Bun.serve over a fake-manager gateway
// on an ephemeral port and checks the SPA route, the REST snapshot, and that a fresh
// WebSocket receives a snapshot frame first. Run: bun run src/web/server.smoke.ts
import { WebGateway } from "./gateway";
import { startWebServer } from "./server";
import { provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";
import type { MeshEvent, MeshConfig } from "../acp/types";

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
    resolvePermission() {},
    async setMode() {},
    async setModel() {},
    async setAgentEffort() {},
    interruptAgent() {},
    async defineMesh() {},
    async deleteMesh() {},
    async reloadDefinitionsPreservingRuntime() {},
    async stopAll() {},
  };
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

// Device-auth (P6): seed an approved token in an isolated root and give the gateway that root so
// the Bearer below is accepted. Loopback is no longer trusted — every /api/* call needs the token.
const auth = await provisionE2eAuth();
const authd = { authorization: `Bearer ${auth.token}` };
const gw = new WebGateway(fakeManager() as any, undefined, { root: auth.authRoot });
const handle = startWebServer({ gateway: gw, port: 0 });
try {
  // REST snapshot
  const stateRes = await fetch(`${handle.url}/api/state`, { headers: authd });
  assert(stateRes.status === 200, "/api/state status 200");
  const state = (await stateRes.json()) as any;
  assert(state.meshes?.[0]?.name === "demo", "snapshot has demo mesh");

  // SPA route serves bundled HTML
  const htmlRes = await fetch(`${handle.url}/`);
  assert(htmlRes.status === 200, "/ status 200");
  const ct = htmlRes.headers.get("content-type") ?? "";
  assert(ct.includes("text/html"), `/ is html (got ${ct})`);
  const html = await htmlRes.text();
  assert(/<script/i.test(html), "bundled html references a script");

  // Step 7.0 — `/bnw/*` deep links SPA-fall-back to index.html (new console namespace).
  for (const p of ["/bnw/", "/bnw/mesh/demo", "/bnw/mesh/demo/board", "/bnw/settings",
                   "/bnw/mesh/demo/agent/router/file/config.json"]) {
    const r = await fetch(`${handle.url}${p}`);
    assert(r.status === 200, `${p} status 200 (got ${r.status})`);
    assert((r.headers.get("content-type") ?? "").includes("text/html"), `${p} is html`);
    assert((r.headers.get("cache-control") ?? "").includes("no-store"), `${p} is no-store`);
  }
  // old root UI routes are UNCHANGED (still served)
  for (const p of ["/", "/mesh/demo"]) {
    const r = await fetch(`${handle.url}${p}`);
    assert(r.status === 200, `old route ${p} still 200 (got ${r.status})`);
    assert((r.headers.get("content-type") ?? "").includes("text/html"), `old route ${p} still html`);
  }
  // a missing `/bnw/` bundle asset (known extension, not a file-viewer path) is a real 404
  const missingAsset = await fetch(`${handle.url}/bnw/does-not-exist.js`);
  assert(missingAsset.status === 404, `missing /bnw asset 404 (got ${missingAsset.status})`);
  // design routes stay guarded (MESH_UI_PREVIEW unset here) → 404
  const mockup = await fetch(`${handle.url}/__ui-mockup`);
  assert(mockup.status === 404, `__ui-mockup guarded 404 (got ${mockup.status})`);
  // /api/* still gates: no Bearer → 401 (auth unchanged)
  const ungated = await fetch(`${handle.url}/api/state`);
  assert(ungated.status === 401, `/api/state without token 401 (got ${ungated.status})`);

  // unknown route 404 (Bearer so it passes the gate and reaches the router, not a 401)
  const nope = await fetch(`${handle.url}/api/nope`, { headers: authd });
  assert(nope.status === 404, "unknown api route 404");

  // WebSocket snapshot-first
  const firstFrame = await new Promise<any>((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${handle.port}/ws?token=${encodeURIComponent(auth.token)}`);
    const timer = setTimeout(() => rej(new Error("ws timeout")), 3000);
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      try {
        res(JSON.parse(String(ev.data)));
      } catch (e) {
        rej(e);
      } finally {
        ws.close();
      }
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      rej(new Error("ws error"));
    };
  });
  assert(firstFrame.t === "snapshot", `first ws frame is snapshot (got ${firstFrame.t})`);
  assert(firstFrame.state?.meshes?.[0]?.name === "demo", "ws snapshot has demo mesh");

  console.log("SMOKE OK: rest snapshot, spa html, 404, ws snapshot-first all good");
} finally {
  handle.stop();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
