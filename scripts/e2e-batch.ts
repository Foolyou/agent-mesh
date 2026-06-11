// Batch runner for diagnosing flaky real-agent e2e (src/e2e.ts) failures.
// Runs ROUNDS rounds with E2E_DEBUG=1, enforces a per-round timeout, checks for
// leaked mesh-host daemons after every round, and keeps full per-round logs
// (stdout + stderr incl. the [trace] event NDJSON) in e2e-logs/.
// Usage: ROUNDS=8 bun run scripts/e2e-batch.ts
import { spawn } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";

const ROUNDS = Number(process.env.ROUNDS ?? 8);
const E2E_TIMEOUT_MS = 480_000;
const KILL_GRACE_MS = 15_000;
const PROBE = "test_mesh_0/e2e-probe.txt";
const LOG_DIR = "e2e-logs";

interface RunResult {
  round: number;
  exitCode: number | null;
  signal: string | null;
  allPass: boolean;
  failLines: string[];
  durationMs: number;
  leakedPids: string[];
}

function pidsMatching(pattern: string): string[] {
  const res = Bun.spawnSync(["pgrep", "-f", pattern]);
  const out = res.stdout.toString().trim();
  return out ? out.split("\n").filter((p) => Number(p) !== process.pid) : [];
}

async function runOne(round: number): Promise<RunResult> {
  await rm(PROBE, { force: true });
  const start = Date.now();

  return new Promise((resolveRun) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const child = spawn("bun", ["run", "src/e2e.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, E2E_DEBUG: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout!.on("data", (d) => stdoutChunks.push(String(d)));
    child.stderr!.on("data", (d) => stderrChunks.push(String(d)));

    const timeout = setTimeout(() => {
      console.log(`  [batch] round ${round} timed out, SIGTERM`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, E2E_TIMEOUT_MS);

    child.on("exit", async (code, signal) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - start;
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");

      // Leak check: only daemons spawned from this worktree; never touch other hosts.
      await Bun.sleep(2000);
      const leakedPids = pidsMatching(`${process.cwd()}/src/mesh-host.ts`);
      for (const pid of leakedPids) {
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }

      const failLines = stdout.split("\n").filter((l) => l.startsWith("❌"));
      const allPass = stdout.includes("ALL PASS");

      const body = `=== ROUND ${round} ===\nExit: ${code} signal=${signal}\nDuration: ${(durationMs / 1000).toFixed(1)}s\nLeaked daemons: ${leakedPids.join(",") || "none"}\n\n--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}\n`;
      await Bun.write(`${LOG_DIR}/round-${round}.log`, body);

      resolveRun({ round, exitCode: code, signal: signal ?? null, allPass, failLines, durationMs, leakedPids });
    });
  });
}

async function main() {
  await mkdir("test_mesh_0", { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });

  const pre = [...pidsMatching("src/mesh-host.ts"), ...pidsMatching("src/e2e.ts")];
  if (pre.length) {
    console.error(`[batch] ABORT: e2e/mesh-host already running (pids ${pre.join(",")}) — concurrent e2e?`);
    process.exit(2);
  }

  const results: RunResult[] = [];
  for (let i = 1; i <= ROUNDS; i++) {
    console.log(`\n=== Round ${i}/${ROUNDS} ===`);
    const r = await runOne(i);
    results.push(r);
    console.log(`  exit=${r.exitCode}/${r.signal} dur=${(r.durationMs / 1000).toFixed(1)}s leak=${r.leakedPids.length} ${r.allPass ? "ALL PASS" : `FAIL:\n${r.failLines.map((l) => `    ${l}`).join("\n")}`}`);
  }

  console.log("\n========== SUMMARY ==========");
  for (const r of results) {
    console.log(`Round ${r.round}: ${r.allPass ? "PASS" : "FAIL"} dur=${(r.durationMs / 1000).toFixed(0)}s exit=${r.exitCode}/${r.signal} leak=${r.leakedPids.length}`);
  }
  const fails = results.filter((r) => !r.allPass).length;
  console.log(`Failures: ${fails}/${ROUNDS}`);
  process.exit(fails ? 1 : 0);
}

main();
