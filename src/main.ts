// src/main.ts — one binary, three commands:
//   mesh                  combined single process (SPA + API + WS in-process)
//   mesh backend [--port] headless control plane: REST API + WS only
//   mesh web [--port] [--backend URL]   SPA + reverse-proxy /api + /ws to a backend
//
// Flags: --fake (scripted demo, no real agents), --no-master (skip the master agent).
// The subprocess-per-mesh model is unchanged; the backend (or combined) process owns
// MeshManager and reaps the whole mesh-host subprocess tree on exit.
import { MeshManager } from "./mesh-manager";
import { MasterAgent } from "./master-agent";
import { WebGateway } from "./web/gateway";
import { startWebServer } from "./web/server";
import { startApiServer } from "./web/api-server";
import { FakeManager, FakeMaster } from "./web/fake";
import { DEMO_MESH } from "./config";

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (f: string) => process.argv.includes(f);
const sub = process.argv[2];
const cmd = sub && !sub.startsWith("-") ? sub : "all";
const fake = has("--fake");
const noMaster = has("--no-master");

async function buildGateway() {
  const manager: any = fake ? new FakeManager() : new MeshManager();
  if (!fake) {
    await manager.loadDefinitions();
    if (!manager.listMeshes().some((m: { name: string }) => m.name === DEMO_MESH.name)) {
      await manager.defineMesh(DEMO_MESH);
    }
  }
  const master: any = fake ? new FakeMaster() : noMaster ? undefined : new MasterAgent(manager);
  const gateway = new WebGateway(manager, master);
  if (fake) {
    gateway.setMasterStatus("ready");
  } else if (master) {
    master
      .start()
      .then(() => gateway.setMasterStatus("ready"))
      .catch(() => gateway.setMasterStatus("absent"));
  }
  return { manager, master, gateway };
}

function reapOnExit(stop: () => Promise<void> | void) {
  let down = false;
  const shutdown = async () => {
    if (down) return;
    down = true;
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (cmd === "backend") {
  const port = Number(process.env.MESH_API_PORT) || Number(argVal("--port")) || 7300;
  const { manager, master, gateway } = await buildGateway();
  const server = startApiServer(gateway, { port });
  console.log(`\n  mesh backend (REST + WS) → ${server.url}${fake ? "  (fake)" : ""}\n`);
  reapOnExit(async () => {
    server.stop();
    gateway.dispose();
    await Promise.allSettled([manager.stopAll(), master?.stop?.()]);
  });
} else if (cmd === "web") {
  const port = Number(process.env.MESH_WEB_PORT) || Number(argVal("--port")) || 7317;
  const backendUrl = argVal("--backend") || process.env.MESH_BACKEND_URL || "http://localhost:7300";
  const server = startWebServer({ port, backendUrl });
  console.log(`\n  mesh web (SPA) → ${server.url}  → proxying to backend ${backendUrl}\n`);
  reapOnExit(() => server.stop());
} else {
  // default: combined single process
  const port = Number(process.env.MESH_WEB_PORT) || Number(argVal("--port")) || 7317;
  const { manager, master, gateway } = await buildGateway();
  const server = startWebServer({ port, gateway });
  console.log(`\n  agent-mesh web console → ${server.url}${fake ? "  (fake mode)" : ""}\n`);
  reapOnExit(async () => {
    server.stop();
    gateway.dispose();
    await Promise.allSettled([manager.stopAll(), master?.stop?.()]);
  });
}
