// Manual verification that an agent now knows it is in a mesh: starts the real demo
// mesh, directly prompts a *member* (codex-1) to introduce itself, and prints the
// member's reply (reconstructed via the real client reducer). Run:
//   bun run src/web/briefing.check.ts
import { emptyState, applyMsg } from "./client/store";
import type { GatewayState } from "./types";

const PORT = Number(process.env.E2E_PORT) || 7416;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function post(path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const server = Bun.spawn(["bun", "run", "src/main.ts", "--no-master", "--port", String(PORT)], {
  stdout: "ignore",
  stderr: "ignore",
});

let state: GatewayState = emptyState();

async function main() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + "/api/state")).ok) break;
    } catch {}
    await sleep(250);
  }
  await post("/api/meshes/demo/start", {});
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  ws.onmessage = (ev) => {
    try {
      state = applyMsg(state, JSON.parse(String(ev.data)));
    } catch {}
  };

  // wait for codex-1 ready
  for (let i = 0; i < 40; i++) {
    const st = await (await fetch(BASE + "/api/state")).json();
    const m = st.meshes.find((x: any) => x.name === "demo");
    if (m?.agents.find((a: any) => a.id === "codex-1")?.status === "ready") break;
    await sleep(1000);
  }

  console.log(">>> directly prompting member codex-1 to introduce itself…\n");
  await post("/api/meshes/demo/agents/codex-1/prompt", {
    text:
      "请你做一下自我介绍：你叫什么？你在一个什么样的环境/团队里工作？你有哪些队友、谁是 router？" +
      "你有哪些可以用来协作的工具？(简洁回答)",
  });

  for (let i = 0; i < 12; i++) {
    await sleep(10_000);
    const items = state.perMesh.demo?.transcripts?.["codex-1"] ?? [];
    const lastMsg = items.filter((it: any) => it.kind === "message" && it.role === "agent").slice(-1)[0] as any;
    if (lastMsg?.complete) break;
    console.log(`  …waiting (${items.length} items so far)`);
  }

  const items = state.perMesh.demo?.transcripts?.["codex-1"] ?? [];
  console.log("\n=== codex-1 transcript (agent messages) ===\n");
  for (const it of items as any[]) {
    if (it.kind === "message" && it.role === "agent") console.log(it.text + "\n");
    if (it.kind === "tool_call") console.log(`[tool] ${it.title} (${it.status})`);
  }
  await post("/api/meshes/demo/stop", {});
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
}
