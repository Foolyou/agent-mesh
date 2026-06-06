// Boot smoke: start the demo mesh, assert all agents reach "ready". (points 1, 2)
import { ControlPlane } from "./control-plane";
import { DEMO_MESH } from "./config";

const cp = new ControlPlane(DEMO_MESH);
const ready = new Set<string>();
cp.on((e) => {
  if (e.kind === "agent_status") {
    console.log(`[status] ${e.agent} -> ${e.status}${e.detail ? ` (${e.detail})` : ""}`);
    if (e.status === "ready") ready.add(e.agent);
  }
});

const timeout = setTimeout(() => {
  console.error("[boot] TIMEOUT");
  cp.stop();
  process.exit(1);
}, 120_000);

await cp.start();
clearTimeout(timeout);
console.log("[boot] ready agents:", [...ready].join(", "));
const ok = ready.size === DEMO_MESH.agents.length;
await cp.stop();
console.log(`[boot] ${ok ? "OK" : "FAIL"}`);
process.exit(ok ? 0 : 1);
