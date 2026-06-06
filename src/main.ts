// src/main.ts
// Boot the MeshManager + an optional MasterAgent + the React/Bun WebUI control
// console. The demo mesh definition is seeded so there is something to start on
// first run. The subprocess-per-mesh model is unchanged: this parent process owns
// the manager, the optional master agent, and now a web server instead of a TUI.
import { MeshManager } from "./mesh-manager";
import { MasterAgent } from "./master-agent";
import { WebGateway } from "./web/gateway";
import { startWebServer } from "./web/server";
import { FakeManager, FakeMaster } from "./web/fake";
import { DEMO_MESH } from "./config";

function argPort(): number | undefined {
  const i = process.argv.indexOf("--port");
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return undefined;
}
const port = Number(process.env.MESH_WEB_PORT) || argPort() || 7317;
const noMaster = process.argv.includes("--no-master");
const fake = process.argv.includes("--fake");

// `--fake`: a self-contained scripted demo (no real agents). Otherwise the real
// MeshManager + optional MasterAgent over the unchanged subprocess-per-mesh model.
const manager: any = fake ? new FakeManager() : new MeshManager();
if (!fake) {
  await manager.loadDefinitions();
  if (!manager.listMeshes().some((m: { name: string }) => m.name === DEMO_MESH.name)) {
    await manager.defineMesh(DEMO_MESH);
  }
}

const master: any = fake ? new FakeMaster() : noMaster ? undefined : new MasterAgent(manager);
const gateway = new WebGateway(manager, master);
const server = startWebServer(gateway, { port });

console.log(`\n  agent-mesh web console → ${server.url}${fake ? "  (fake mode)" : ""}\n`);

if (fake) {
  gateway.setMasterStatus("ready");
} else if (master) {
  // Start the master agent in the background so the UI is available immediately.
  // Degrade gracefully if it cannot start (e.g. no local claude login).
  master
    .start()
    .then(() => gateway.setMasterStatus("ready"))
    .catch(() => gateway.setMasterStatus("absent"));
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop();
  gateway.dispose();
  await Promise.allSettled([manager.stopAll(), master?.stop()]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
