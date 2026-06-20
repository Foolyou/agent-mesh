// src/service.ts
// Backend service management, built into the binary: run/stop/inspect the backend as a
// background process under a root, with up/down/status/restart/logs. State lives in
// <root>/backend.json ({pid,port,startedAt}) + <root>/backend.log. `root` is the resolved
// storage dir (<base>/.agent-mesh); `base` is what we pass back as --root so a re-spawned
// backend resolves to the same root.
import { join, resolve } from "node:path";
import { openSync, existsSync } from "node:fs";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { listLiveRecords, reapAllHosts, pidAlive } from "./mesh-registry";
import { findPidOnPort } from "./os-shim";

/** How to re-exec ourselves: the compiled binary runs itself; dev runs the source script. */
function selfCmd(...args: string[]): string[] {
  const script = resolve(import.meta.dir, "main.ts");
  return existsSync(script) ? [process.execPath, script, ...args] : [process.execPath, ...args];
}

interface BackendRec {
  pid: number;
  port: number;
  startedAt: string;
}

const recPath = (root: string) => join(root, "backend.json");
const logPath = (root: string) => join(root, "backend.log");
const runDir = (root: string) => join(root, "run");

async function readRec(root: string): Promise<BackendRec | undefined> {
  try {
    const r = JSON.parse(await readFile(recPath(root), "utf8")) as BackendRec;
    return typeof r?.pid === "number" ? r : undefined;
  } catch {
    return undefined;
  }
}
async function writeRec(root: string, rec: BackendRec): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(recPath(root), JSON.stringify(rec), "utf8");
}
const removeRec = (root: string) => rm(recPath(root), { force: true }).catch(() => {});

/** The backend HTTP service is RESPONDING within a short timeout. Liveness, not authorization:
 *  under mandatory device auth (device-auth phase 6) an unauthenticated `/api/state` probe gets 401,
 *  which still proves the server is up — so any response with status < 500 counts as alive. Only a
 *  5xx, a network error, or a timeout counts as unhealthy. No token is sent: this is a local liveness
 *  probe (used by `mesh up/status/restart` and scripts/update.sh), not a data read. */
async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2500) });
    return res.status < 500;
  } catch {
    return false;
  }
}
/** The live backend pid for this root: the recorded pid if alive, else the port listener. */
async function backendPid(root: string, port?: number): Promise<number | undefined> {
  const rec = await readRec(root);
  if (rec && pidAlive(rec.pid)) return rec.pid;
  return port !== undefined ? (findPidOnPort(port) ?? undefined) : undefined;
}

/** Strip the mesh-host control env so a re-spawned backend can't misfire as a host. */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MESH_")) out[k] = v;
  return out;
}

/** Cold stop: SIGTERM→SIGKILL every mesh daemon under this root, only forgetting each
 *  (record + socket) once its pid is confirmed dead, and sweeping orphaned sockets. */
async function reapDaemons(root: string): Promise<number> {
  const r = await reapAllHosts(runDir(root));
  if (r.cleaned > r.killed) console.log(`swept ${r.cleaned - r.killed} stale daemon artifact(s)`);
  if (r.survived.length) console.error(`warning: ${r.survived.length} daemon(s) survived SIGKILL: ${r.survived.join(", ")}`);
  return r.killed;
}

async function waitGone(pid: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && pidAlive(pid)) await Bun.sleep(150);
}

export interface UpOpts {
  cold?: boolean;
  /** extra flags to forward to the spawned backend (e.g. --fake, --no-assistant) */
  passthrough?: string[];
}

/** Background-start the backend (idempotent). `--cold` reaps stale daemons first. */
export async function up(base: string, root: string, port: number, opts: UpOpts = {}): Promise<void> {
  // One backend per ROOT: if a recorded backend for this root is alive, don't start another
  // (even on a different port — they'd share the same registry/meshes and corrupt state).
  const existing = await readRec(root);
  if (existing && pidAlive(existing.pid)) {
    console.log(`already running → pid ${existing.pid}, port ${existing.port}  (root ${root})`);
    return;
  }
  if (await healthy(port)) {
    console.log(`already running → http://localhost:${port}  (root ${root})`);
    return;
  }
  if (opts.cold) await reapDaemons(root);
  await mkdir(root, { recursive: true });
  const fd = openSync(logPath(root), "a");
  // Fully daemonize: `detached` puts the backend in its OWN session (setsid), so killing
  // the launching shell/session can't take it down with us — what you want from a service.
  // (Bun's `detached` keeps child.pid as the real process; we just don't await its exit.)
  // It also ignores SIGHUP. No subcommand → combined SPA + API + WS, like production.
  const child = Bun.spawn(selfCmd(...(opts.passthrough ?? []), "--port", String(port), "--root", base), {
    cwd: process.cwd(),
    env: cleanEnv(),
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    detached: true,
  });
  child.unref(); // don't keep THIS process alive waiting on the detached backend
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await healthy(port)) {
      await writeRec(root, { pid: child.pid, port, startedAt: new Date().toISOString() });
      console.log(`backend up → http://localhost:${port}  (pid ${child.pid}, root ${root})`);
      return;
    }
    await Bun.sleep(250);
  }
  console.error(`backend did not become healthy on ${port} — see ${logPath(root)}`);
  process.exitCode = 1;
}

/** Stop the backend (hot: leave mesh daemons; --cold: also reap them). */
export async function down(root: string, port: number, opts: { cold?: boolean } = {}): Promise<void> {
  const pid = await backendPid(root, port);
  if (pid) {
    console.log(`stopping backend pid ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
    await waitGone(pid, 8000);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  } else {
    console.log("backend not running");
  }
  await removeRec(root);
  if (opts.cold) {
    const n = await reapDaemons(root);
    console.log(`reaped ${n} mesh daemon(s)`);
  }
}

/** Print backend up/down + port + running meshes. */
export async function status(root: string, port: number): Promise<void> {
  console.log(`service : ${root}`);
  console.log(`port    : ${port}`);
  const pid = await backendPid(root, port);
  if (await healthy(port)) console.log(`backend : UP (pid ${pid ?? "?"})`);
  else if (pid) console.log(`backend : starting/unhealthy (pid ${pid})`);
  else console.log("backend : DOWN");
  const running = await listLiveRecords(runDir(root));
  console.log("meshes  :");
  if (running.length) for (const r of running) console.log(`  ${r.name}\tpid ${r.pid}`);
  else console.log("  (none running)");
}

/** Restart the backend. Hot keeps the mesh daemons. A COLD restart reaps the daemons —
 *  if invoked from inside a mesh that would kill this very process, so cold dispatches a
 *  DETACHED worker (own session) that survives the reap and finishes the restart. */
export async function restart(base: string, root: string, port: number, opts: UpOpts = {}): Promise<void> {
  if (opts.cold && process.env.MESH_RESTART_WORKER !== "1") {
    const fd = openSync(logPath(root), "a");
    const worker = Bun.spawn(selfCmd("restart", ...(opts.passthrough ?? []), "--root", base, "--port", String(port), "--cold"), {
      cwd: process.cwd(),
      env: { ...cleanEnv(), MESH_RESTART_WORKER: "1" },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      detached: true,
    });
    worker.unref(); // fire-and-forget: the detached worker outlives us
    console.log("cold restart dispatched (detached worker) — see backend.log");
    return;
  }
  await down(root, port, { cold: opts.cold });
  await up(base, root, port, { passthrough: opts.passthrough });
}

/** Show or follow the backend log. */
export async function logs(root: string, opts: { follow?: boolean } = {}): Promise<void> {
  const path = logPath(root);
  const proc = Bun.spawn(opts.follow ? ["tail", "-f", path] : ["tail", "-n", "40", path], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
