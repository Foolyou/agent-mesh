// Task 7 smoke (point 4): a member's request_permission escalates to the
// control plane; a simulated human grants it; the gated op then runs.
import { resolve } from "node:path";
import { rm, stat } from "node:fs/promises";
import { ControlPlane } from "../control-plane";
import { DEMO_MESH } from "../config";

const probe = resolve(process.cwd(), "test_mesh_0", "perm-probe.txt");
await rm(probe, { force: true });

const cp = new ControlPlane(DEMO_MESH, { permissionTimeoutMs: 90_000 });
let permSeen = false;
let resolvedByHuman = false;

cp.on((e) => {
  if (e.kind === "permission") {
    permSeen = true;
    console.log(`[permission] ${e.agent}: ${e.question} :: options=${e.options.map((o) => `${o.name}(${o.kind})`).join(", ")}`);
    // Simulate the human pressing a key shortly after the prompt appears.
    setTimeout(() => {
      const allow = e.options.find((o) => o.kind === "allow_once") ?? e.options.find((o) => /allow|yes|approve/i.test(o.name)) ?? e.options[0];
      if (allow) {
        console.log(`[human] granting ${allow.name}`);
        cp.resolveDecision(e.requestId, allow.id, "human");
      }
    }, 800);
  }
  if (e.kind === "permission_resolved" && e.by === "human") resolvedByHuman = true;
});

const timeout = setTimeout(() => {
  console.error("[perm-smoke] overall timeout");
  cp.stop();
  process.exit(1);
}, 180_000);

await cp.start();
// Put codex into read-only so a write requires approval -> request_permission.
await cp.agent("codex-1").setMode("read-only");
await cp.prompt(
  "codex-1",
  "Create a file named perm-probe.txt in the current directory containing exactly the text 'ok'. " +
    "You are in read-only mode, so you must request approval to write it. Request the approval and, once granted, create the file.",
).catch((e) => console.error("[perm-smoke] prompt error", String(e)));

// give the write a moment to land
const deadline = Date.now() + 10_000;
let fileExists = false;
while (Date.now() < deadline) {
  try {
    await stat(probe);
    fileExists = true;
    break;
  } catch {
    await Bun.sleep(500);
  }
}

clearTimeout(timeout);
console.log(`[perm-smoke] permSeen=${permSeen} resolvedByHuman=${resolvedByHuman} fileExists=${fileExists}`);
await cp.stop();
process.exit(permSeen && resolvedByHuman && fileExists ? 0 : 1);
