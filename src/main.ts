// src/main.ts
// Boot the MeshManager + an optional MasterAgent + interactive TUI. The demo
// mesh definition is seeded so there is something to start on first run.
import { MeshManager } from "./mesh-manager";
import { MasterAgent } from "./master-agent";
import { DEMO_MESH } from "./config";
import { Tui } from "./tui/app";

const manager = new MeshManager();
await manager.loadDefinitions();
// Seed the demo definition if absent (idempotent; validated on define).
if (!manager.listMeshes().some((m) => m.name === DEMO_MESH.name)) {
  await manager.defineMesh(DEMO_MESH);
}

const master = new MasterAgent(manager);
const tui = new Tui(manager, master);
tui.start();

process.on("SIGINT", () => {
  tui.stop();
  Promise.allSettled([manager.stopAll(), master.stop()]).finally(() => process.exit(0));
});

await master.start().catch(() => {
  // Master agent is optional; the manager + TUI still work without it.
});
