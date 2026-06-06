// src/flows/mesh-lifecycle.smoke.ts
// Manual smoke: define -> start -> prompt router -> stop, with real agents.
// Run: bun run src/flows/mesh-lifecycle.smoke.ts
import { MeshManager } from "../mesh-manager";
import { DEMO_MESH } from "../config";
import { Mesh } from "../mesh";

const routerId = new Mesh(DEMO_MESH).router.id;

const manager = new MeshManager();
let routerSpoke = false;
manager.on((name, e) => {
  if (e.kind === "update" && e.agent === routerId) routerSpoke = true;
  if (e.kind === "update") console.log(`[${name}] ${e.agent}`, (e.update as any)?.sessionUpdate);
});

await manager.defineMesh(DEMO_MESH);
console.log("defined:", manager.listMeshes());
await manager.startMesh(DEMO_MESH.name);
console.log("started:", manager.listMeshes());

await manager.promptRouter(DEMO_MESH.name, "Say hello in one short sentence, then stop.");
await Bun.sleep(20_000);

await manager.stopMesh(DEMO_MESH.name);
console.log("stopped:", manager.listMeshes());
console.log(routerSpoke ? "PASS: router responded" : "WARN: no router activity observed");
process.exit(0);
