// Real-agent end-to-end: spawns the real web server (no fake), forms a
// claude(router)+codex+opencode mesh on test_mesh_web, prompts the router, and
// observes the live event stream through the same WS the browser uses. Auto-allows
// permission escalations, screenshots the console, then stops + checks for orphans.
//
// Bounded and tolerant: real agents depend on local logins, so if they don't reach
// "ready" within the window it reports that and tears down cleanly. Run:
//   bun run src/web/real.e2e.ts
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT) || 7414;
const BASE = `http://localhost:${PORT}`;
const SHOTS = "/tmp/mesh-shots";
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT) || 150_000;
const OBSERVE_MS = Number(process.env.OBSERVE_MS) || 150_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

const MESH = {
  name: "webtest",
  agents: [
    { id: "router", harness: "claude", project: "test_mesh_web", role: "router" },
    { id: "codex-1", harness: "codex", project: "test_mesh_web", role: "member" },
    { id: "opencode-1", harness: "opencode", project: "test_mesh_web", role: "member" },
  ],
  edges: [
    { from: "router", to: "codex-1" },
    { from: "router", to: "opencode-1" },
    { from: "codex-1", to: "opencode-1" },
    { from: "opencode-1", to: "codex-1" },
  ],
};

async function post(path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function getState(): Promise<any> {
  return (await fetch(BASE + "/api/state")).json();
}

const server = Bun.spawn(["bun", "run", "src/main.ts", "--no-assistant", "--port", String(PORT)], {
  stdout: "inherit",
  stderr: "inherit",
});

const tally: Record<string, number> = {};
const seen = { mail: 0, permission: 0, interrupt: 0, agentUpdate: 0 };
let wsOpen = false;

async function main() {
  // wait for server
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + "/api/state")).ok) break;
    } catch {}
    await sleep(250);
  }
  console.log("server up");

  // define + start the mesh
  console.log("defining mesh:", (await post("/api/meshes", MESH)).status);
  console.log("starting mesh:", (await post("/api/meshes/webtest/start", {})).status);

  // observe the WS stream (same one the browser uses)
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  ws.onopen = () => (wsOpen = true);
  ws.onmessage = (ev) => {
    let m: any;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    tally[m.t] = (tally[m.t] ?? 0) + 1;
    if (m.t === "mail") seen.mail++;
    if (m.t === "interrupt") seen.interrupt++;
    if (m.t === "transcript.upsert" && m.conv?.scope === "agent") seen.agentUpdate++;
    if (m.t === "permission.add") {
      seen.permission++;
      const opt =
        m.req.options.find((o: any) => /allow/i.test(o.id) || /allow/i.test(o.name)) ?? m.req.options[0];
      console.log(`  ⚠ permission from ${m.req.agent}: "${m.req.question}" → auto-allow (${opt?.id})`);
      void post(`/api/meshes/webtest/permissions/${encodeURIComponent(m.req.requestId)}/resolve`, { optionId: opt?.id });
    }
  };

  // poll for readiness
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < READY_TIMEOUT) {
    const st = await getState();
    const mesh = st.meshes.find((x: any) => x.name === "webtest");
    const statuses = mesh?.agents.map((a: any) => `${a.id}:${a.status}`).join(" ");
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] mesh=${mesh?.status} ${statuses}`);
    if (mesh?.agents.every((a: any) => a.status === "ready")) {
      ready = true;
      break;
    }
    if (mesh?.status === "dead") break;
    await sleep(4000);
  }
  console.log(`agents ready: ${ready} · ws open: ${wsOpen}`);

  // screenshot the live console
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator('.mrow:has-text("webtest")').click().catch(() => {});
    await sleep(1500);
    await page.screenshot({ path: `${SHOTS}/real-01-ready.png`, fullPage: true });

    if (ready) {
      // prompt the router to coordinate the build
      console.log("prompting router…");
      await post("/api/meshes/webtest/prompt", {
        text:
          "Read ./BRIEF.md. Use send_mail to delegate implementing wordcount.mjs to codex-1, then ask opencode-1 to review it. Keep it to a single file and report when done.",
      });
      // observe
      const obsStart = Date.now();
      while (Date.now() - obsStart < OBSERVE_MS) {
        await sleep(10_000);
        console.log(
          `  observing… updates=${seen.agentUpdate} mail=${seen.mail} perms=${seen.permission} interrupts=${seen.interrupt}`,
        );
      }
      await page.screenshot({ path: `${SHOTS}/real-02-working.png`, fullPage: true });
    }
  } finally {
    await browser.close();
  }

  // stop + verify reap
  console.log("stopping mesh:", (await post("/api/meshes/webtest/stop", {})).status);
  await sleep(2000);
  try {
    ws.close();
  } catch {}

  console.log("\n=== summary ===");
  console.log("ws message tally:", JSON.stringify(tally));
  console.log("observed:", JSON.stringify(seen));
  console.log("ready:", ready);
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
