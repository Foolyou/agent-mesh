// Regression e2e for the "cold restart triggered from INSIDE a mesh" footgun: a --cold
// restart reaps the mesh, and the reap (the daemon's SIGTERM handler → ControlPlane.stop()
// → killTree of its agents) kills the agent + the shell running the restart script. Without
// detaching the restart worker, the script dies after stopping the backend but before
// restarting it, so the backend never comes back (10010 "permanently inaccessible").
// restart-work.sh now double-forks the worker to init so it survives the reap.
//
// This drives the real backend + a selfkill daemon fixture whose "agent" runs the actual
// restart-work.sh --cold, and asserts the backend comes back UP + the mesh is reaped.
// Run: bun run src/web/cold-from-inside.e2e.ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = Number(process.env.E2E_PORT) || 7720;
const BASE = `http://localhost:${PORT}`;
const REPO = resolve(import.meta.dir, "..", "..");
const ROOT = await mkdtemp(join(tmpdir(), "cold-inside-"));
const SELFKILL = resolve(REPO, "src", "fixtures", "selfkill-host.ts");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const state = async () => (await fetch(`${BASE}/api/state`)).ok;

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
const post = (p: string, body?: unknown) =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
async function regPid(name: string): Promise<number | null> {
  try {
    const j = JSON.parse(await readFile(join(ROOT, ".agent-mesh", "run", `${name}.json`), "utf8"));
    return j.pid ?? null;
  } catch {
    return null;
  }
}

// the simulated agent runs the REAL restart script (cold) from inside the mesh
const AGENT_CMD = `exec bash ${join(REPO, "scripts", "restart-work.sh")} --cold > ${ROOT}/agent.log 2>&1`;
const backend = Bun.spawn(["bun", "run", "src/main.ts", "backend", "--port", String(PORT), "--root", ROOT], {
  cwd: REPO,
  env: {
    ...process.env,
    MESH_HOST_SCRIPT: SELFKILL,
    MESH_AGENT_CMD: AGENT_CMD,
    MESH_WORK_ROOT: ROOT,
    MESH_WORK_PORT: String(PORT),
    MESH_LAUNCH_CMD: "bun run src/main.ts backend",
    MESH_API_PORT: "",
  },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  for (let i = 0; i < 80; i++) {
    if (await state().catch(() => false)) break;
    await sleep(250);
  }

  let daemonPid: number | null = null;
  await step("start a mesh → its daemon spawns the agent that runs `restart-work.sh --cold`", async () => {
    await post("/api/meshes", { name: "x", agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }], edges: [] });
    await post("/api/meshes/x/start");
    for (let i = 0; i < 40; i++) {
      daemonPid = await regPid("x");
      if (daemonPid) break;
      await sleep(200);
    }
    if (!daemonPid) throw new Error("mesh daemon never registered");
  });

  await step("backend comes back UP after the in-mesh cold restart (the fix)", async () => {
    // the agent reaps the mesh (killing itself); the detached worker must survive + restart.
    let up = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (await state().catch(() => false)) {
        up = true;
        break;
      }
    }
    if (!up) throw new Error("backend never came back — the cold-from-inside restart died with the agent");
  });

  await step("the mesh was actually reaped (cold), not left running", async () => {
    // give the reap a moment, then the registry record should be gone + the pid dead
    await sleep(500);
    if (await regPid("x")) throw new Error("mesh registry record still present after --cold");
    if (daemonPid) {
      let alive = true;
      try {
        process.kill(daemonPid, 0);
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`mesh daemon ${daemonPid} still alive after --cold`);
    }
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  COLD-FROM-INSIDE E2E OK — restart survives reaping its own mesh");
  }
} finally {
  backend.kill("SIGKILL");
  // reap the restarted backend (new pid on PORT) + any surviving daemon
  try {
    const out = Bun.spawnSync(["bash", "-c", `ss -ltnp 2>/dev/null | grep ':${PORT} ' | sed -nE 's/.*pid=([0-9]+).*/\\1/p' | head -1`]).stdout.toString().trim();
    if (out) process.kill(Number(out), "SIGKILL");
  } catch {}
  for (const n of ["x"]) {
    const p = await regPid(n);
    if (p) try { process.kill(p, "SIGKILL"); } catch {}
  }
  await rm(ROOT, { recursive: true, force: true });
}
