// Manual verification that an agent now knows it is in a mesh: starts the real demo
// mesh, directly prompts a *member* (codex-1) to introduce itself, and prints the
// member's reply (reconstructed via the real client reducer). Run:
//   bun run src/web/briefing.check.ts
import { emptyState, applyMsg } from "./client/store";
import { authedReady, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";
import type { GatewayState } from "./types";

const PORT = Number(process.env.E2E_PORT) || 7416;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Device-auth (P6): seed an approved token in an isolated root, hand it to the spawned server via
// MESH_ROOT, and carry the Bearer on every /api/* call (+ ?token= on /ws). Loopback isn't trusted.
const auth = await provisionE2eAuth();
const authd = { authorization: `Bearer ${auth.token}` };

async function post(path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...authd },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const server = Bun.spawn(["bun", "run", "src/main.ts", "run", "--no-assistant", "--port", String(PORT)], {
  stdout: "ignore",
  stderr: "ignore",
  env: auth.env,
});

let state: GatewayState = emptyState();

async function main() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await authedReady(BASE, auth.token)).ok) break;
    } catch {}
    await sleep(250);
  }
  // define a mesh WITH a team charter, then verify a member can state the team goal
  await post("/api/meshes", {
    name: "brief-demo",
    agents: [
      { id: "router", harness: "claude", project: "test_mesh_0", role: "router" },
      { id: "codex-1", harness: "codex", project: "test_mesh_0", role: "member" },
    ],
    edges: [
      { from: "router", to: "codex-1" },
      { from: "codex-1", to: "router" },
    ],
    charter:
      "Goal: collaboratively maintain a tiny wordcount CLI. " +
      "Norms: keep every change minimal, always write a test, and hand results back to the router via send_mail when done.",
  });
  await post("/api/meshes/brief-demo/start", {});
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(auth.token)}`);
  ws.onmessage = (ev) => {
    try {
      state = applyMsg(state, JSON.parse(String(ev.data)));
    } catch {}
  };

  // wait for codex-1 ready
  for (let i = 0; i < 40; i++) {
    const st = await (await fetch(BASE + "/api/state", { headers: authd })).json();
    const m = st.meshes.find((x: any) => x.name === "brief-demo");
    if (m?.agents.find((a: any) => a.id === "codex-1")?.status === "ready") break;
    await sleep(1000);
  }

  console.log(">>> directly prompting member codex-1 to introduce itself + state the team charter…\n");
  await post("/api/meshes/brief-demo/agents/codex-1/prompt", {
    text:
      "请简短回答：你叫什么、你的角色、你在哪个 mesh 团队、谁是 router？" +
      "另外，这个团队的【目标和规范】是什么？(用一两句话概括 charter)",
  });

  for (let i = 0; i < 12; i++) {
    await sleep(10_000);
    const items = state.perMesh["brief-demo"]?.transcripts?.["codex-1"]?.items ?? [];
    const lastMsg = items.filter((it: any) => it.kind === "message" && it.role === "agent").slice(-1)[0] as any;
    if (lastMsg?.complete) break;
    console.log(`  …waiting (${items.length} items so far)`);
  }

  const items = state.perMesh["brief-demo"]?.transcripts?.["codex-1"]?.items ?? [];
  console.log("\n=== codex-1 transcript (agent messages) ===\n");
  for (const it of items as any[]) {
    if (it.kind === "message" && it.role === "agent") console.log(it.text + "\n");
    if (it.kind === "tool_call") console.log(`[tool] ${it.title} (${it.status})`);
  }
  await post("/api/meshes/brief-demo/stop", {});
  await sleep(1500);
  try {
    ws.close();
  } catch {}
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
