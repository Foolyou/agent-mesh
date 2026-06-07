// Daemon-survival e2e through the REAL backend CLI: start a backend, define + start a
// mesh, KILL the backend, confirm the mesh daemon outlives it, restart the backend, and
// confirm it auto-reattaches (status running, replay restored, can still drive it). Uses
// the echo daemon fixture via MESH_HOST_SCRIPT so no real agents are needed.
// Run: bun run src/web/daemon-restart.e2e.ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = Number(process.env.E2E_PORT) || 7560;
const BASE = `http://localhost:${PORT}`;
const ROOT = await mkdtemp(join(tmpdir(), "daemon-e2e-"));
const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "echo-host.ts");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
const fails: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    fails.push(name);
    console.log(`  ✗ ${name} — ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

function spawnBackend() {
  return Bun.spawn(["bun", "run", "src/main.ts", "backend", "--port", String(PORT), "--root", ROOT], {
    env: { ...process.env, MESH_HOST_SCRIPT: FIXTURE, MESH_API_PORT: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
}
async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/api/state`)).ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const post = (p: string, body?: unknown) =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

const ECHO = { name: "echo", agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }], edges: [] };

let backend = spawnBackend();
try {
  if (!(await waitReady())) throw new Error("backend 1 never came up");

  let daemonPid = 0;
  await step("define + start a mesh → running", async () => {
    if (!(await post("/api/meshes", ECHO)).ok) throw new Error("define failed");
    if (!(await post("/api/meshes/echo/start")).ok) throw new Error("start failed");
    await sleep(300);
    const s = await state();
    const m = s.meshes.find((x: any) => x.name === "echo");
    if (m?.status !== "running") throw new Error(`status ${m?.status} != running`);
    const rec = JSON.parse(await readFile(join(ROOT, "run", "echo.json"), "utf8"));
    daemonPid = rec.pid;
    if (!daemonPid) throw new Error("no registry pid");
  });

  await step("a prompt produces an event (lands in the daemon's replay ring)", async () => {
    await post("/api/meshes/echo/prompt", { text: "before" });
    await sleep(200);
    const s = await state();
    const act = s.perMesh.echo?.activity ?? [];
    if (!act.some((a: any) => String(a.text).includes("echo:before"))) throw new Error("no echo:before activity");
  });

  await step("KILL the backend → the mesh daemon survives it", async () => {
    backend.kill("SIGTERM");
    await backend.exited;
    await sleep(300);
    // the daemon (separate process) is still alive
    let alive = true;
    try {
      process.kill(daemonPid, 0);
    } catch {
      alive = false;
    }
    if (!alive) throw new Error(`daemon pid ${daemonPid} died with the backend`);
  });

  await step("restart the backend → it auto-reattaches (status running, same daemon)", async () => {
    backend = spawnBackend();
    if (!(await waitReady())) throw new Error("backend 2 never came up");
    await sleep(300);
    const s = await state();
    const m = s.meshes.find((x: any) => x.name === "echo");
    if (m?.status !== "running") throw new Error(`after restart status ${m?.status} != running (no reattach)`);
    const rec = JSON.parse(await readFile(join(ROOT, "run", "echo.json"), "utf8"));
    if (rec.pid !== daemonPid) throw new Error(`reattached to a DIFFERENT daemon (${rec.pid} != ${daemonPid})`);
  });

  await step("replay restored the pre-restart event into the fresh backend", async () => {
    const s = await state();
    const act = s.perMesh.echo?.activity ?? [];
    if (!act.some((a: any) => String(a.text).includes("echo:before"))) throw new Error("pre-restart event not replayed");
  });

  await step("the reattached daemon is still drivable", async () => {
    await post("/api/meshes/echo/prompt", { text: "after" });
    await sleep(300);
    const s = await state();
    const act = s.perMesh.echo?.activity ?? [];
    if (!act.some((a: any) => String(a.text).includes("echo:after"))) throw new Error("reattached daemon did not respond");
  });

  await step("mesh stop reaps the daemon cleanly", async () => {
    await post("/api/meshes/echo/stop");
    await sleep(300);
    let alive = true;
    try {
      process.kill(daemonPid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`daemon pid ${daemonPid} still alive after stop`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  DAEMON-RESTART E2E OK — mesh survives backend restart + auto-reattaches");
  }
} finally {
  backend.kill("SIGKILL");
  // best-effort reap of any surviving daemon
  try {
    const rec = JSON.parse(await readFile(join(ROOT, "run", "echo.json"), "utf8"));
    process.kill(rec.pid, "SIGKILL");
  } catch {}
  await rm(ROOT, { recursive: true, force: true });
}
