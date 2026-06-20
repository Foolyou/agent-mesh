// src/mesh-cli-ops.ts — single-mesh lifecycle command orchestration for the `mesh` CLI (design:
// docs/design/mesh-cli-lifecycle.md §B–§D). Pure over an injected MeshControlClient so the exit-code
// mapping, idempotency, and the restart stop→poll→start sequence are unit-testable without a real
// backend. Each op returns { exitCode, out, err }; main.ts prints and sets process.exitCode.

import type { ControlOutcome, MeshControlClient } from "./mesh-control-client";

/** Approved CLI exit codes (mesh-cli-lifecycle §C). */
export const EXIT = { ok: 0, other: 1, usage: 2, notFound: 4, backendDown: 5, auth: 6 } as const;

export interface OpResult {
  exitCode: number;
  out: string[];
  err: string[];
}

export type LifecycleCommand = "start" | "stop" | "status" | "restart";

/** The resolved intent of a lifecycle command's verbatim tail. `usage` carries the line to print on
 *  exit 2. `control-plane` is only ever returned for a no-arg `status`/`restart`. */
export type LifecyclePlan =
  | { kind: "mesh"; name: string; fresh: boolean }
  | { kind: "control-plane" }
  | { kind: "usage"; usage: string };

const USAGE: Record<LifecycleCommand, string> = {
  start: "usage: mesh start <name> [--fresh]   (use `mesh up` to start the control plane)",
  stop: "usage: mesh stop <name>   (use `mesh down` to stop the control plane)",
  status: "usage: mesh status <name>   (omit <name> for control-plane status)",
  restart: "usage: mesh restart <name>   (omit <name> to restart the control plane)",
};

/** Parse a single-mesh lifecycle command's tail STRICTLY (globals are already peeled by the resolver).
 *  Rejects extra positionals and stray local flags with `usage` (→ exit 2) so a typo can never silently
 *  act on the wrong target. `start` additionally allows exactly one `--fresh`; `stop`/`status`/`restart`
 *  allow no local flags. A no-arg `status`/`restart` (empty tail) is the control-plane command; a
 *  `status`/`restart` whose tail is non-empty but not a single bare name is a usage error (NOT a silent
 *  fallback to the control plane). */
export function parseLifecycleTail(cmd: LifecycleCommand, tail: string[]): LifecyclePlan {
  const positionals = tail.filter((t) => !t.startsWith("-"));
  const flags = tail.filter((t) => t.startsWith("-"));
  const usage = (): LifecyclePlan => ({ kind: "usage", usage: USAGE[cmd] });

  if ((cmd === "status" || cmd === "restart") && tail.length === 0) return { kind: "control-plane" };

  if (positionals.length !== 1) return usage(); // need exactly one mesh name (missing or extra)

  if (cmd === "start") {
    const fresh = flags.filter((f) => f === "--fresh");
    const other = flags.filter((f) => f !== "--fresh");
    if (other.length > 0 || fresh.length > 1) return usage(); // only a single bare `--fresh` is allowed
    return { kind: "mesh", name: positionals[0]!, fresh: fresh.length === 1 };
  }
  // stop / status / restart: no local flags permitted on the single-mesh path
  if (flags.length > 0) return usage();
  return { kind: "mesh", name: positionals[0]!, fresh: false };
}

const isStopped = (s: string) => s === "stopped" || s === "dead";
const isRunning = (s: string) => s === "running" || s === "starting";

function notFound(name: string): OpResult {
  return { exitCode: EXIT.notFound, out: [], err: [`no such mesh "${name}"`] };
}

/** Map a failed control outcome to the approved exit code + message. backend-down adds the `mesh up` hint. */
function mapErr(o: Extract<ControlOutcome<unknown>, { ok: false }>): OpResult {
  switch (o.reason) {
    case "backend-down":
      return { exitCode: EXIT.backendDown, out: [], err: ["control plane not running — run `mesh up`"] };
    case "auth":
      return { exitCode: EXIT.auth, out: [], err: ["authorization failed"] };
    case "not-found":
      return { exitCode: EXIT.notFound, out: [], err: [o.message ?? "mesh not found"] };
    default:
      return { exitCode: EXIT.other, out: [], err: [o.message ?? "request failed"] };
  }
}

export async function opStatus(client: MeshControlClient, name: string): Promise<OpResult> {
  const g = await client.getMeshes();
  if (!g.ok) return mapErr(g);
  const m = g.data.find((x) => x.name === name);
  if (!m) return notFound(name);
  const out = [`${m.name}: ${m.status}`];
  for (const a of m.agents) out.push(`  ${a.id} · ${a.harness} · ${a.status}`);
  return { exitCode: EXIT.ok, out, err: [] };
}

export async function opStart(client: MeshControlClient, name: string, opts: { fresh: boolean }): Promise<OpResult> {
  const g = await client.getMeshes();
  if (!g.ok) return mapErr(g);
  const m = g.data.find((x) => x.name === name);
  if (!m) return notFound(name);
  // Idempotent no-op only for a plain start of an already-running mesh; `--fresh` always re-issues so the
  // API decides (fresh sessions), per the approved decision.
  if (isRunning(m.status) && !opts.fresh) return { exitCode: EXIT.ok, out: [`mesh "${name}" already running`], err: [] };
  const r = await client.meshAction(name, "start", opts.fresh ? { sessionStrategy: "fresh" } : undefined);
  if (!r.ok) return mapErr(r);
  return { exitCode: EXIT.ok, out: [`mesh "${name}" started${opts.fresh ? " (fresh sessions)" : ""}`], err: [] };
}

export async function opStop(client: MeshControlClient, name: string): Promise<OpResult> {
  const g = await client.getMeshes();
  if (!g.ok) return mapErr(g);
  const m = g.data.find((x) => x.name === name);
  if (!m) return notFound(name);
  if (isStopped(m.status)) return { exitCode: EXIT.ok, out: [`mesh "${name}" already stopped`], err: [] };
  const r = await client.meshAction(name, "stop");
  if (!r.ok) return mapErr(r);
  return { exitCode: EXIT.ok, out: [`mesh "${name}" stopped`], err: [] };
}

export interface RestartOpts {
  /** Injected for tests; defaults to Bun.sleep. */
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  pollMs?: number;
  now?: () => number;
}

/** restart = graceful stop → poll GET /api/meshes until stopped/dead → start (no new endpoint). */
export async function opRestart(client: MeshControlClient, name: string, opts: RestartOpts = {}): Promise<OpResult> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? (() => Date.now());
  const maxWaitMs = opts.maxWaitMs ?? 10_000;
  const pollMs = opts.pollMs ?? 250;

  const g = await client.getMeshes();
  if (!g.ok) return mapErr(g);
  let m = g.data.find((x) => x.name === name);
  if (!m) return notFound(name);

  if (!isStopped(m.status)) {
    const stop = await client.meshAction(name, "stop");
    if (!stop.ok) return mapErr(stop);
    const deadline = now() + maxWaitMs;
    for (;;) {
      const gg = await client.getMeshes();
      if (!gg.ok) return mapErr(gg);
      m = gg.data.find((x) => x.name === name);
      if (!m) return notFound(name);
      if (isStopped(m.status)) break;
      if (now() >= deadline) {
        return { exitCode: EXIT.other, out: [], err: [`restart: mesh "${name}" did not stop within ${Math.round(maxWaitMs / 1000)}s`] };
      }
      await sleep(pollMs);
    }
  }
  const start = await client.meshAction(name, "start");
  if (!start.ok) return mapErr(start);
  return { exitCode: EXIT.ok, out: [`mesh "${name}" restarted`], err: [] };
}
