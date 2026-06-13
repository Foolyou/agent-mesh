import { mkdir } from "node:fs/promises";
import type { HarnessId } from "./acp/types";
import { join } from "node:path";
import { assertManagedNpmPrefix, assertSafeNpmPackageSpec, managedNpmPrefix, npmPackageSpec } from "./harness-install-spec";
import { clearHarnessModelsCache } from "./harness-models";
import { clearHarnessProbeCache, probeHarnesses } from "./harness-probe";
import type { ServerMsg } from "./web/types";

type InstallStatus = "running" | "done" | "error";
type InstallEvent = { ts: number; step: string; message?: string };
type SpawnHandle = { exited: Promise<number>; stdout?: ReadableStream<Uint8Array> | null; stderr?: ReadableStream<Uint8Array> | null; kill?: () => void };

export interface InstallJob {
  id: string;
  harnessId: HarnessId;
  pkgSpec: string;
  startedAt: number;
  status: InstallStatus;
  events: InstallEvent[];
  child?: SpawnHandle;
  error?: string;
  done: Promise<InstallJob>;
}

export interface HarnessInstallOptions {
  prefix?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  random?: () => number;
  which?: (command: string) => string | null;
  spawn?: (argv: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => SpawnHandle;
  clearProbeCache?: (id?: HarnessId) => void;
  clearModelsCache?: (id?: HarnessId) => void;
  reprobe?: typeof probeHarnesses;
  broadcast?: (event: ServerMsg) => void;
}

export class HarnessInstallError extends Error {
  constructor(public code: "missing-npm" | "not-installable" | "spawn-failed", message: string) {
    super(message);
  }
}

const NPM_INSTALLABLE = new Set<HarnessId>(["claude", "codex"]);
const activeJobs = new Map<HarnessId, InstallJob>();
const historyJobs = new Map<string, InstallJob>();

export function getActiveHarnessInstallJob(id: HarnessId): InstallJob | undefined {
  return activeJobs.get(id);
}

export function getHarnessInstallJob(jobId: string): InstallJob | undefined {
  for (const job of activeJobs.values()) if (job.id === jobId) return job;
  return historyJobs.get(jobId);
}

export function resetHarnessInstallJobsForTests(): void {
  activeJobs.clear();
  historyJobs.clear();
}

export async function startHarnessInstall(harnessId: HarnessId, opts: HarnessInstallOptions = {}): Promise<InstallJob> {
  if (!NPM_INSTALLABLE.has(harnessId)) throw new HarnessInstallError("not-installable", `harness ${harnessId} is not npm-installable`);
  const existing = activeJobs.get(harnessId);
  if (existing) return existing;
  if ((opts.which ?? Bun.which)("npm") == null) throw new HarnessInstallError("missing-npm", "Install Node.js first");

  const prefix = assertManagedNpmPrefix(opts.prefix ?? managedNpmPrefix(opts.home), opts.home);
  const cachePath = join(prefix, ".cache");
  const pkgSpec = npmPackageSpec(harnessId);
  assertSafeNpmPackageSpec(pkgSpec);
  await mkdir(prefix, { recursive: true });
  await mkdir(cachePath, { recursive: true });

  const now = opts.now ?? Date.now;
  const job: InstallJob = {
    id: randomJobId(opts.random),
    harnessId,
    pkgSpec,
    startedAt: now(),
    status: "running",
    events: [{ ts: now(), step: "start" }],
    done: undefined as any,
  };
  activeJobs.set(harnessId, job);

  try {
    const argv = [
      "npm",
      "install",
      "--prefix",
      assertManagedNpmPrefix(prefix, opts.home),
      "--cache",
      cachePath,
      "--registry",
      "https://registry.npmjs.org/",
      "--ignore-scripts",
      "--no-progress",
      "--no-fund",
      "--no-audit",
      pkgSpec,
    ];
    const env = {
      ...(opts.env ?? process.env),
      // Experiment 2026-06-13: npm CLI --ignore-scripts beat local ignore-scripts=false.
      // Keep the env lock too so user/global npmrc cannot re-enable lifecycle scripts.
      npm_config_ignore_scripts: "true",
    };
    const spawn = opts.spawn ?? ((args, spawnOpts) => Bun.spawn(args, spawnOpts));
    job.child = spawn(argv, { cwd: prefix, env });
  } catch (err: any) {
    activeJobs.delete(harnessId);
    job.status = "error";
    job.error = String(err?.message ?? err);
    historyJobs.set(job.id, job);
    throw new HarnessInstallError("spawn-failed", job.error);
  }

  job.done = settleInstallJob(job, opts);
  return job;
}

async function settleInstallJob(job: InstallJob, opts: HarnessInstallOptions): Promise<InstallJob> {
  try {
    const code = await job.child!.exited;
    if (code !== 0) throw new Error(`npm install exited with code ${code}`);
    job.status = "done";
    job.events.push({ ts: (opts.now ?? Date.now)(), step: "done" });
    const clearProbe = opts.clearProbeCache ?? clearHarnessProbeCache;
    const clearModels = opts.clearModelsCache ?? clearHarnessModelsCache;
    clearProbe(job.harnessId);
    clearModels(job.harnessId);
    await (opts.reprobe ?? probeHarnesses)({ refresh: true });
    opts.broadcast?.({ t: "harnesses-changed", harnessId: job.harnessId });
    return job;
  } catch (err: any) {
    job.status = "error";
    job.error = String(err?.message ?? err);
    job.events.push({ ts: (opts.now ?? Date.now)(), step: "error", message: job.error });
    return job;
  } finally {
    activeJobs.delete(job.harnessId);
    historyJobs.set(job.id, job);
  }
}

function randomJobId(random = Math.random): string {
  return Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0");
}
