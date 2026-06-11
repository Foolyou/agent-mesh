// Integration smoke for the split (two-process) topology: a headless backend
// (startApiServer) + a web tier (startWebServer in proxy mode) pointing at it.
// Verifies the SPA is served, REST is proxied, a POST round-trips, and a browser
// WebSocket receives the backend snapshot through the proxy. Run:
//   bun run src/web/split.smoke.ts
import { WebGateway } from "./gateway";
import { startApiServer } from "./api-server";
import { startWebServer } from "./server";
import type { MeshEvent, MeshConfig } from "../acp/types";

const CFG: MeshConfig = {
  name: "demo",
  agents: [{ id: "router", harness: "claude", project: "p", role: "router" }],
  edges: [],
};

function fakeManager() {
  const calls: any[] = [];
  return {
    calls,
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
    async startMesh(n: string) {
      calls.push(["start", n]);
    },
    async stopMesh() {},
    async promptRouter() {},
    promptAgent() {},
    resolvePermission() {},
    async setMode() {},
    async setModel() {},
    async setAgentEffort() {},
    async setAgentBypass() {},
    interruptAgent() {},
    async defineMesh() {},
    async deleteMesh() {},
    async loadDefinitions() {},
    async stopAll() {},
  };
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`SPLIT SMOKE FAIL: ${msg}`);
}

const mgr = fakeManager();
const gw = new WebGateway(mgr as any);
const backend = startApiServer(gw, { port: 0 });
const web = startWebServer({ port: 0, backendUrl: backend.url });

try {
  assert(web.mode === "proxy", "web server is in proxy mode");

  // backend serves the API directly
  const direct = await fetch(`${backend.url}/api/state`);
  assert(direct.status === 200, "backend /api/state 200");
  assert((await direct.json()).meshes[0].name === "demo", "backend snapshot has demo");

  // backend does NOT serve the SPA
  const backRoot = await fetch(`${backend.url}/`);
  assert(backRoot.status === 404, "backend / is 404 (no SPA in backend)");

  // web serves the bundled SPA
  const html = await fetch(`${web.url}/`);
  assert(html.status === 200 && (html.headers.get("content-type") ?? "").includes("text/html"), "web serves SPA html");

  // web proxies GET /api/state to the backend
  const proxied = await fetch(`${web.url}/api/state`);
  assert(proxied.status === 200, "web proxies /api/state");
  assert((await proxied.json()).meshes[0].name === "demo", "proxied snapshot has demo");

  // web proxies a POST (command) to the backend
  const started = await fetch(`${web.url}/api/meshes/demo/start`, { method: "POST" });
  assert(started.status === 200, "web proxies POST start");
  assert(mgr.calls.some((c) => c[0] === "start"), "backend received the proxied start command");

  // web proxies the WebSocket: a browser socket gets the backend snapshot
  const firstFrame = await new Promise<any>((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${web.port}/ws`);
    const timer = setTimeout(() => rej(new Error("ws timeout")), 4000);
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
    ws.onerror = () => {
      clearTimeout(timer);
      rej(new Error("ws error"));
    };
  });
  assert(firstFrame.t === "snapshot", `proxied ws first frame is snapshot (got ${firstFrame.t})`);
  assert(firstFrame.state?.meshes?.[0]?.name === "demo", "proxied ws snapshot has demo");

  console.log("SPLIT SMOKE OK: backend api/ws + web spa + proxied rest/post/ws all good");
} finally {
  web.stop();
  backend.stop();
}
