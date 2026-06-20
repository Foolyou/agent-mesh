// End-to-end test for single-mesh lifecycle CLI commands (mesh-cli-lifecycle C3). Spawns a REAL combined
// control plane (`mesh run --fake`) under a temp root and drives the actual `mesh` binary against it
// through the real host-key auth path (the CLI signs a bearer the running backend verifies). Covers:
// backend-down exit 5; missing-name exit 2; start/stop/status/restart <name>; start --fresh; no-arg
// status stays control-plane; kill usage unchanged.
//
// NOTE: this test may itself run inside a mesh agent (MESH_SOCK/MESH_CONFIG set), which would make a
// spawned `mesh` re-exec as a mesh-host. We strip every MESH_* var from the child env (mirrors
// service.cleanEnv) so the child always runs the CLI/control plane, never the host body.
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "main.ts");

function childEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MESH_")) e[k] = v;
  return e;
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const p = s.port ?? 0;
  s.stop(true);
  if (!p) throw new Error("could not allocate a free port");
  return p;
}

async function waitHealthy(port: number, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1000) });
      if (r.status < 500) return true; // 401 (unauth) still proves the server is up
    } catch {
      /* not up yet */
    }
    await Bun.sleep(200);
  }
  return false;
}

interface CliResult { code: number; out: string; err: string; }
async function cli(base: string, port: number, args: string[]): Promise<CliResult> {
  const p = Bun.spawn([process.execPath, MAIN, ...args, "--port", String(port), "--root", base], {
    stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv(),
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

async function withBase<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "mesh-cli-e2e-"));
  try {
    return await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("backend-down → exit 5 (run `mesh up`); missing name → exit 2; kill usage unchanged", async () => {
  await withBase(async (base) => {
    const port = freePort(); // nothing listening here
    const down = await cli(base, port, ["status", "demo"]);
    expect(down.code).toBe(5);
    expect(down.err).toContain("mesh up");

    expect((await cli(base, port, ["start"])).code).toBe(2); // single-mesh command, no name
    expect((await cli(base, port, ["stop"])).code).toBe(2);
    const kill = await cli(base, port, ["kill"]); // unchanged: usage + exit 2
    expect(kill.code).toBe(2);
    expect(kill.err.toLowerCase()).toContain("usage: mesh kill");
  });
}, 30_000);

test("full single-mesh lifecycle against a real --fake control plane (host-key auth path)", async () => {
  await withBase(async (base) => {
    const port = freePort();
    const backend = Bun.spawn([process.execPath, MAIN, "run", "--fake", "--no-assistant", "--port", String(port), "--root", base], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv(),
    });
    try {
      expect(await waitHealthy(port)).toBe(true);

      // status of the predefined fake "demo" mesh (initially stopped) — proves the host-key bearer is
      // signed by the CLI and verified by the running backend over the real gate.
      const s0 = await cli(base, port, ["status", "demo"]);
      expect(s0.code).toBe(0);
      expect(s0.out).toContain("demo: stopped");

      // start → running
      const start = await cli(base, port, ["start", "demo"]);
      expect(start.code).toBe(0);
      expect(start.out).toContain("started");
      expect((await cli(base, port, ["status", "demo"])).out).toContain("demo: running");

      // idempotent start of an already-running mesh → exit 0, no-op
      const again = await cli(base, port, ["start", "demo"]);
      expect(again.code).toBe(0);
      expect(again.out).toContain("already running");

      // restart = stop → poll until stopped → start (no new endpoint) → running again
      const restart = await cli(base, port, ["restart", "demo"]);
      expect(restart.code).toBe(0);
      expect(restart.out).toContain("restarted");
      expect((await cli(base, port, ["status", "demo"])).out).toContain("demo: running");

      // stop → stopped; idempotent second stop
      expect((await cli(base, port, ["stop", "demo"])).code).toBe(0);
      expect((await cli(base, port, ["status", "demo"])).out).toContain("demo: stopped");
      expect((await cli(base, port, ["stop", "demo"])).out).toContain("already stopped");

      // start --fresh from a stopped mesh → exits 0, the CLI reports fresh sessions (body carries
      // sessionStrategy:"fresh"; the wire shape is asserted in the client unit test)
      const fresh = await cli(base, port, ["start", "demo", "--fresh"]);
      expect(fresh.code).toBe(0);
      expect(fresh.out).toContain("fresh sessions");
      expect((await cli(base, port, ["status", "demo"])).out).toContain("demo: running");

      // a missing mesh → exit 4
      expect((await cli(base, port, ["status", "no-such-mesh"])).code).toBe(4);

      // no-arg status stays the CONTROL-PLANE command (service status, not a single mesh)
      const svc = await cli(base, port, ["status"]);
      expect(svc.code).toBe(0);
      expect(svc.out).toContain("control"); // service.status prints "control : UP/…"
      expect(svc.out).not.toContain("demo:"); // not the single-mesh format
    } finally {
      backend.kill();
      await backend.exited;
    }
  });
}, 60_000);
