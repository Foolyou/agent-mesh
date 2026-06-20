// Manual verification that the Mesh Assistant can now DELETE and MODIFY meshes by
// natural language (new delete_mesh / get_mesh / update_mesh tools). Boots a combined
// server with a real Mesh Assistant, then drives it. Run: bun run src/web/mesh-assistant-tools.check.ts
import { provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";

const PORT = Number(process.env.E2E_PORT) || 7360;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Device-auth (P6): seed an approved token in an isolated root, hand it to the spawned server via
// MESH_ROOT, and carry the Bearer on every /api/* call. Loopback is no longer trusted.
const auth = await provisionE2eAuth();
const authd = { authorization: `Bearer ${auth.token}` };

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...authd },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const state = () => fetch(BASE + "/api/state", { headers: authd }).then((r) => r.json());
const meshNames = async () => (await state()).meshes.map((m: any) => m.name);

const server = Bun.spawn(["bun", "run", "src/main.ts", "--port", String(PORT)], { stdout: "ignore", stderr: "ignore", env: auth.env });

async function waitAssistantReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const s = await state();
      if (s.assistant?.status === "ready") return true;
      if (s.assistant?.status === "absent") return false;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function main() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + "/api/state", { headers: authd })).ok) break;
    } catch {}
    await sleep(250);
  }
  const ready = await waitAssistantReady();
  console.log(`assistant ready: ${ready}`);
  if (!ready) return;

  const R = { id: "router", harness: "claude", project: "test_mesh_0", role: "router" };

  // ── DELETE ──────────────────────────────────────────────────────────────────
  await api("POST", "/api/meshes", { name: "scratch-del", agents: [R], edges: [] });
  console.log("created scratch-del; asking assistant to delete it…");
  await api("POST", "/api/assistant/prompt", { text: 'Delete the mesh named "scratch-del". Just do it.' });
  let deleted = false;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    if (!(await meshNames()).includes("scratch-del")) {
      deleted = true;
      break;
    }
  }
  console.log(deleted ? "✓ assistant DELETED scratch-del" : "✗ scratch-del still present");

  // ── MODIFY ──────────────────────────────────────────────────────────────────
  await api("POST", "/api/meshes", { name: "scratch-mod", agents: [R], edges: [] });
  console.log("created scratch-mod (project=test_mesh_0); asking assistant to change the project to test_mesh_web…");
  await api("POST", "/api/assistant/prompt", {
    text:
      'In the mesh "scratch-mod", change the working directory (project) of the router agent from test_mesh_0 to test_mesh_web. ' +
      "Use get_mesh to read it, then update_mesh with the change.",
  });
  let modified = false;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    const cfg = await api("GET", "/api/meshes/scratch-mod/config");
    if (cfg.body?.agents?.[0]?.project === "test_mesh_web") {
      modified = true;
      break;
    }
  }
  console.log(modified ? "✓ assistant MODIFIED scratch-mod project → test_mesh_web" : "✗ scratch-mod project unchanged");

  // cleanup
  await api("DELETE", "/api/meshes/scratch-mod");
  console.log(`\nRESULT: delete=${deleted} modify=${modified}`);
}

try {
  await main();
} finally {
  server.kill("SIGINT");
  await sleep(6000);
  try {
    server.kill("SIGKILL");
  } catch {}
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
