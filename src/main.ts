// src/main.ts — one binary, three commands:
//   mesh                  combined single process (SPA + API + WS in-process)
//   mesh backend [--port] headless control plane: REST API + WS only
//   mesh web [--port] [--backend URL]   SPA + reverse-proxy /api + /ws to a backend
//
// Flags: --fake (scripted demo, no real agents), --no-master (skip the master agent).
// The subprocess-per-mesh model is unchanged; the backend (or combined) process owns
// MeshManager and reaps the whole mesh-host subprocess tree on exit.
import { MeshManager } from "./mesh-manager";
import { MasterAgent } from "./master-agent";
import { WebGateway } from "./web/gateway";
import { startWebServer } from "./web/server";
import { startApiServer } from "./web/api-server";
import { FakeManager, FakeMaster } from "./web/fake";
import { runMeshHost } from "./mesh-host";
import { resolveRoot, expandHome } from "./root";
import { homedir } from "node:os";
import * as service from "./service";

// Single-binary support: when this binary is re-execed as a mesh-host subprocess
// (MeshHostClient sets MESH_SOCK/MESH_CONFIG), run the host body instead of the CLI.
if (process.env.MESH_SOCK && process.env.MESH_CONFIG) {
  await runMeshHost();
} else {
  await runCli();
}

async function runCli() {

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (f: string) => process.argv.includes(f);
const sub = process.argv[2];
const cmd = sub && !sub.startsWith("-") ? sub : "all";
const fake = has("--fake");
const noMaster = has("--no-master");

const root = resolveRoot();
// the base dir we'd pass back as --root so a re-spawned backend resolves to the same root
const base = argVal("--root") ? expandHome(argVal("--root")!) : homedir();

async function buildGateway() {
  const manager: any = fake ? new FakeManager() : new MeshManager({ root });
  // Real backend: load whatever the user has defined in their root and nothing more.
  // (We deliberately do NOT seed a sample mesh — the user's storage root stays clean;
  // the UI's empty state guides first-run mesh creation. `--fake` provides the demo.)
  if (!fake) await manager.loadDefinitions();
  let gateway: WebGateway;
  const master: any = fake
    ? new FakeMaster()
    : noMaster
      ? undefined
      : new MasterAgent(manager, { uploadRoot: root, onCapabilities: (caps) => gateway?.setMasterCapabilities(caps) });
  gateway = new WebGateway(manager, master, { root });
  if (!fake) {
    // Reconnect to any mesh daemons that outlived a previous backend (the whole point of
    // the daemon model): their agents kept running; we re-attach and the daemon replays
    // what we missed. Done AFTER the gateway subscribes so the replay rebuilds its view.
    const back = await manager.reattachRunning();
    if (back.length) console.log(`  reattached to running mesh(es): ${back.join(", ")}`);
  }
  if (fake) {
    gateway.setMasterStatus("ready");
    gateway.setMasterCapabilities({ image: true });
  } else if (master) {
    master
      .start()
      .then(() => gateway.setMasterStatus("ready"))
      .catch(() => gateway.setMasterStatus("absent"));
  }
  return { manager, master, gateway };
}

function reapOnExit(stop: () => Promise<void> | void) {
  let down = false;
  const shutdown = async () => {
    if (down) return;
    down = true;
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Survive a terminal hangup so a backend started via `mesh up` (or in a closing shell)
  // isn't taken down with the launcher; stop is explicit (SIGINT/SIGTERM / `mesh down`).
  process.on("SIGHUP", () => {});
}

// ── service management (background backend under a root) ─────────────────────────
const svcPort = Number(process.env.MESH_PORT) || Number(argVal("--port")) || 10010;
const svcCold = has("--cold");
// flags forwarded to the spawned backend (so `mesh up --fake --no-master` works)
const svcPass = [...(fake ? ["--fake"] : []), ...(noMaster ? ["--no-master"] : [])];
if (cmd === "up" || cmd === "start") {
  await service.up(base, root, svcPort, { cold: svcCold, passthrough: svcPass });
} else if (cmd === "down" || cmd === "stop") {
  await service.down(root, svcPort, { cold: svcCold });
} else if (cmd === "status") {
  await service.status(root, svcPort);
} else if (cmd === "restart") {
  await service.restart(base, root, svcPort, { cold: svcCold, passthrough: svcPass });
} else if (cmd === "logs") {
  await service.logs(root, { follow: has("-f") || has("--follow") });
} else if (cmd === "ps") {
  // list running mesh daemons (survivors of any prior backend) from the registry
  const mgr = new MeshManager({ root });
  const running = await mgr.listRunning();
  if (!running.length) console.log("no running meshes");
  else for (const r of running) console.log(`${r.name}\tpid ${r.pid}\t${r.socketPath}`);
} else if (cmd === "kill") {
  const target = process.argv[3];
  const mgr = new MeshManager({ root });
  if (target === "--all" || target === "-a") {
    const running = await mgr.listRunning();
    for (const r of running) await mgr.kill(r.name);
    console.log(`killed ${running.length} mesh(es)`);
  } else if (target) {
    console.log((await mgr.kill(target)) ? `killed ${target}` : `no running mesh "${target}"`);
  } else {
    console.error("usage: mesh kill <name> | --all");
    process.exitCode = 2;
  }
} else if (cmd === "backend") {
  const port = Number(process.env.MESH_API_PORT) || Number(argVal("--port")) || 7300;
  const { manager, master, gateway } = await buildGateway();
  const server = startApiServer(gateway, { port });
  console.log(`\n  mesh backend (REST + WS) → ${server.url}${fake ? "  (fake)" : `  · root: ${root}`}\n`);
  reapOnExit(async () => {
    server.stop();
    gateway.dispose();
    manager.disconnectAll?.(); // leave mesh daemons running for the next backend to reattach
    await master?.stop?.();
  });
} else if (cmd === "web") {
  const port = Number(process.env.MESH_WEB_PORT) || Number(argVal("--port")) || 7317;
  const backendUrl = argVal("--backend") || process.env.MESH_BACKEND_URL || "http://localhost:7300";
  const server = startWebServer({ port, backendUrl });
  console.log(`\n  mesh web (SPA) → ${server.url}  → proxying to backend ${backendUrl}\n`);
  reapOnExit(() => server.stop());
} else {
  // default: combined single process
  const port = Number(process.env.MESH_WEB_PORT) || Number(argVal("--port")) || 7317;
  const { manager, master, gateway } = await buildGateway();
  const server = startWebServer({ port, gateway });
  console.log(`\n  agent-mesh web console → ${server.url}${fake ? "  (fake mode)" : `  · root: ${root}`}\n`);
  reapOnExit(async () => {
    server.stop();
    gateway.dispose();
    manager.disconnectAll?.(); // leave mesh daemons running for the next backend to reattach
    await master?.stop?.();
  });
  }
}
