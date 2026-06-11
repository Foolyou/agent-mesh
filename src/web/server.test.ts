import { expect, test } from "bun:test";
import { WebGateway } from "./gateway";
import { startWebServer } from "./server";
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
    async setAgentBypass() {},
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

test("SPA shell routes are served with no-store cache headers", async () => {
  const gw = new WebGateway(fakeManager() as any);
  const server = startWebServer({ gateway: gw, port: 0 });
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
