// Integration smoke for the web server: boots Bun.serve over a fake-manager gateway
// on an ephemeral port and checks the SPA route, the REST snapshot, and that a fresh
// WebSocket receives a snapshot frame first. Run: bun run src/web/server.smoke.ts
import { WebGateway } from "./gateway";
import { startWebServer } from "./server";
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
    setMode() {},
    async defineMesh() {},
    async loadDefinitions() {},
    async stopAll() {},
  };
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

const gw = new WebGateway(fakeManager() as any);
const handle = startWebServer(gw, { port: 0 });
try {
  // REST snapshot
  const stateRes = await fetch(`${handle.url}/api/state`);
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

  // unknown route 404
  const nope = await fetch(`${handle.url}/api/nope`);
  assert(nope.status === 404, "unknown api route 404");

  // WebSocket snapshot-first
  const firstFrame = await new Promise<any>((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${handle.port}/ws`);
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
}
