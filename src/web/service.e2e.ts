// e2e for the built-in service manager (`mesh up/down/status/restart`). Drives the source
// CLI with --fake --no-assistant (no real agents) so it's fast, and asserts the backend is
// background-started, reported, restarted, and stopped under a base dir.
// Run: bun run src/web/service.e2e.ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eAuthRoot, seedApprovedDevice } from "./e2e-playwright";

const PORT = Number(process.env.E2E_PORT) || 7770;
const BASE = await mkdtemp(join(tmpdir(), "svc-e2e-"));
const ROOT = join(BASE, ".agent-mesh");
const e2eToken = await seedApprovedDevice(e2eAuthRoot(BASE));
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

/** run a `mesh` CLI command (source), returning {code, out}. */
async function mesh(...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", "run", "src/main.ts", ...args, "--root", BASE, "--port", String(PORT)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    p.exited,
    Bun.readableStreamToText(p.stdout as ReadableStream),
    Bun.readableStreamToText(p.stderr as ReadableStream),
  ]);
  return { code, out: out + err };
}
const SVC = ["--fake", "--no-assistant"];
const healthy = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(2000), headers: { authorization: `Bearer ${e2eToken}` } })).ok;
  } catch {
    return false;
  }
};
const recPid = async () => {
  try {
    return JSON.parse(await readFile(join(ROOT, "backend.json"), "utf8")).pid as number;
  } catch {
    return undefined;
  }
};

try {
  await step("status before start → DOWN", async () => {
    const { out } = await mesh("status");
    if (!/backend\s*:\s*DOWN/.test(out)) throw new Error(`not DOWN: ${out}`);
  });

  let pid1 = 0;
  await step("up → background backend becomes healthy + record written", async () => {
    const { out } = await mesh("up", ...SVC);
    if (!/backend up/.test(out)) throw new Error(`no 'backend up': ${out}`);
    if (!(await healthy())) throw new Error("not healthy after up");
    pid1 = (await recPid()) ?? 0;
    if (!pid1 || !(() => { try { process.kill(pid1, 0); return true; } catch { return false; } })()) throw new Error(`bad record pid ${pid1}`);
  });

  await step("status → UP with the recorded pid", async () => {
    const { out } = await mesh("status");
    if (!new RegExp(`backend\\s*:\\s*UP \\(pid ${pid1}\\)`).test(out)) throw new Error(`status wrong: ${out}`);
  });

  await step("up again → idempotent (already running)", async () => {
    const { out } = await mesh("up", ...SVC);
    if (!/already running/.test(out)) throw new Error(`not idempotent: ${out}`);
  });

  await step("restart (hot) → a NEW healthy backend", async () => {
    const { out } = await mesh("restart", ...SVC);
    if (!/backend up/.test(out)) throw new Error(`restart didn't come up: ${out}`);
    await sleep(300);
    if (!(await healthy())) throw new Error("not healthy after restart");
    const pid2 = await recPid();
    if (!pid2 || pid2 === pid1) throw new Error(`restart kept the same pid (${pid2})`);
  });

  await step("down → backend stopped, record removed", async () => {
    await mesh("down");
    await sleep(500);
    if (await healthy()) throw new Error("still healthy after down");
    if (await recPid()) throw new Error("record not removed after down");
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  SERVICE E2E OK — mesh up/status/restart/down work");
  }
} finally {
  await mesh("down").catch(() => {});
  // belt-and-suspenders: reap any backend still on the port
  try {
    const out = Bun.spawnSync(["bash", "-c", `ss -ltnp 2>/dev/null | grep ':${PORT} ' | sed -nE 's/.*pid=([0-9]+).*/\\1/p' | head -1`]).stdout.toString().trim();
    if (out) process.kill(Number(out), "SIGKILL");
  } catch {}
  await rm(BASE, { recursive: true, force: true });
}
