import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessId } from "./acp/types";
import { HARNESSES, resolveHarness, type HarnessSpec } from "./harness";
import { AcpAgentConnection } from "./acp/client";
import { NPM_INSTALL_SPEC, SELF_INSTALL_HINTS, managedNpmBin } from "./harness-install-spec";

export type HarnessAuthState = "ok" | "required" | "unknown";
export type HarnessInstallable = "npm" | "self" | "manual";

export interface HarnessProbeResult {
  id: HarnessId;
  label: string;
  installed: boolean;
  version?: string;
  path?: string;
  latest?: string;
  outdated?: boolean;
  auth: HarnessAuthState;
  installable: HarnessInstallable;
  installSpec?: { npmPackage: string; pinnedVersion: string; bin: string };
  installHint?: { command: string; docsUrl: string };
  lastProbeAt: number;
  error?: string;
  runningAgentsUsingOldVersion: string[];
}

export type WhichFn = (command: string, path?: string) => string | null | undefined;

export interface HarnessProbeConnection {
  start(): Promise<void>;
  initialize(): Promise<unknown>;
  kill(): void;
}

export interface HarnessProbeOptions {
  refresh?: boolean;
  ttlMs?: number;
  now?: () => number;
  managedBin?: string;
  which?: WhichFn;
  latest?: () => Promise<Partial<Record<HarnessId, string>> | undefined>;
  createConnection?: (id: HarnessId, spec: HarnessSpec, cwd: string, command: string) => HarnessProbeConnection;
  runningAgentsUsingOldVersion?: (id: HarnessId, latest?: string) => string[];
}

const DEFAULT_TTL_MS = 45_000;
let cache: { at: number; rows: HarnessProbeResult[] } | undefined;
let latestCache: Partial<Record<HarnessId, string>> | undefined;

export function clearHarnessProbeCache(id?: HarnessId): void {
  if (!id) {
    cache = undefined;
    latestCache = undefined;
    return;
  }
  if (cache) cache = { ...cache, rows: cache.rows.filter((row) => row.id !== id) };
  if (latestCache) delete latestCache[id];
}

export async function probeHarnesses(opts: HarnessProbeOptions = {}): Promise<HarnessProbeResult[]> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (!opts.refresh && cache && now() - cache.at < ttlMs) return cache.rows;

  let latest: Partial<Record<HarnessId, string>> | undefined;
  let latestError: string | undefined;
  try {
    latest = opts.latest ? await opts.latest() : await fetchRegistryLatest();
    if (latest) latestCache = latest;
  } catch {
    latest = latestCache;
    latestError = "registry-unavailable";
  }

  const rows: HarnessProbeResult[] = [];
  for (const [id, spec] of Object.entries(HARNESSES) as Array<[HarnessId, HarnessSpec]>) {
    rows.push(await probeOne(id, spec, latest, latestError, opts, now()));
  }
  cache = { at: now(), rows };
  return rows;
}

async function probeOne(
  id: HarnessId,
  spec: HarnessSpec,
  latest: Partial<Record<HarnessId, string>> | undefined,
  latestError: string | undefined,
  opts: HarnessProbeOptions,
  lastProbeAt: number,
): Promise<HarnessProbeResult> {
  const which = opts.which ?? ((command, path) => Bun.which(command, { PATH: path ?? process.env.PATH ?? "" }));
  const managed = opts.managedBin ?? managedNpmBin();
  const path = which(spec.command, managed) ?? which(spec.command);
  const installed = !!path;
  const label = labelOf(id);
  const latestVersion = latest?.[id];
  let version: string | undefined;
  let auth: HarnessAuthState = "unknown";
  let error = latestError;

  if (installed && path) {
    try {
      const init = await probeInitialize(id, spec, opts, path);
      version = stringOrUndefined((init as any)?.agentInfo?.version);
      const authMethods = (init as any)?.authMethods;
      auth = Array.isArray(authMethods) && authMethods.length ? "required" : "ok";
    } catch (err: any) {
      error = String(err?.message ?? err);
    }
  }

  const outdated = version && latestVersion ? compareSemver(version, latestVersion) < 0 : undefined;
  return {
    id,
    label,
    installed,
    version,
    path: path || undefined,
    latest: latestVersion,
    outdated,
    auth,
    ...installMetadata(id),
    lastProbeAt,
    error,
    runningAgentsUsingOldVersion: opts.runningAgentsUsingOldVersion?.(id, latestVersion) ?? [],
  };
}

async function probeInitialize(id: HarnessId, spec: HarnessSpec, opts: HarnessProbeOptions, command: string): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), `mesh-harness-probe-${id}-`));
  const createConnection = opts.createConnection ?? ((_id, s, cwd, cmd) => new AcpAgentConnection({
    id: `harness-probe-${_id}`,
    command: cmd,
    args: s.args,
    cwd,
    fs: false,
    debug: false,
  }));
  const conn = createConnection(id, spec, root, command);
  try {
    await conn.start();
    return await conn.initialize();
  } finally {
    conn.kill();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchRegistryLatest(): Promise<Partial<Record<HarnessId, string>>> {
  const res = await fetch("https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json", {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`registry ${res.status}`);
  const json = await res.json() as any;
  const out: Partial<Record<HarnessId, string>> = {};
  const idMap: Record<string, HarnessId> = { "claude-acp": "claude", "codex-acp": "codex", opencode: "opencode", kimi: "kimi" };
  for (const agent of Array.isArray(json?.agents) ? json.agents : []) {
    const id = idMap[String(agent?.id ?? "")];
    if (id && typeof agent.version === "string") out[id] = agent.version;
  }
  return out;
}

function installMetadata(id: HarnessId): Pick<HarnessProbeResult, "installable" | "installSpec" | "installHint"> {
  if (Object.hasOwn(NPM_INSTALL_SPEC, id)) {
    const spec = NPM_INSTALL_SPEC[id as keyof typeof NPM_INSTALL_SPEC];
    return { installable: "npm", installSpec: { npmPackage: spec.package, pinnedVersion: spec.version, bin: spec.bin } };
  }
  if (Object.hasOwn(SELF_INSTALL_HINTS, id)) {
    return { installable: "self", installHint: SELF_INSTALL_HINTS[id as keyof typeof SELF_INSTALL_HINTS] };
  }
  return { installable: "manual" };
}

function labelOf(id: HarnessId): string {
  return ({ claude: "Claude", codex: "Codex", opencode: "OpenCode", kimi: "Kimi" } as Record<HarnessId, string>)[id];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function resolveHarnessCommand(id: HarnessId): HarnessSpec {
  return resolveHarness(id);
}
