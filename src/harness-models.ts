import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpAgentConnection } from "./acp/client";
import type { HarnessId, SessionModel } from "./acp/types";
import { resolveHarness, type HarnessSpec } from "./harness";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const EFFORT_SUFFIX = /\/(?:minimal|low|medium|high|xhigh)$/;

export interface HarnessModelProbeResult {
  models: SessionModel[];
  probedAt: number;
}

export interface HarnessModelProbeConnection {
  start(): Promise<void>;
  initialize(): Promise<unknown>;
  newSession(): Promise<unknown>;
  kill(): void;
}

export interface HarnessModelProbeOptions {
  refresh?: boolean;
  ttlMs?: number;
  now?: () => number;
  installed?: (id: HarnessId, spec: HarnessSpec) => boolean;
  createConnection?: (id: HarnessId, spec: HarnessSpec, cwd: string) => HarnessModelProbeConnection;
}

const cache = new Map<HarnessId, HarnessModelProbeResult>();
const inflight = new Map<HarnessId, Promise<HarnessModelProbeResult>>();

export async function probeHarnessModels(id: HarnessId, opts: HarnessModelProbeOptions = {}): Promise<HarnessModelProbeResult> {
  const spec = resolveHarness(id);
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const installed = opts.installed ?? ((_id, s) => Bun.which(s.command) !== null);
  if (!installed(id, spec)) throw new Error(`harness ${id} is not installed`);

  const cached = cache.get(id);
  if (!opts.refresh && cached && now() - cached.probedAt < ttlMs) return cached;

  const existing = inflight.get(id);
  if (!opts.refresh && existing) return existing;

  const probe = runProbe(id, spec, opts, now).finally(() => {
    if (inflight.get(id) === probe) inflight.delete(id);
  });
  inflight.set(id, probe);
  return probe;
}

async function runProbe(
  id: HarnessId,
  spec: HarnessSpec,
  opts: HarnessModelProbeOptions,
  now: () => number,
): Promise<HarnessModelProbeResult> {
  const root = await mkdtemp(join(tmpdir(), `mesh-harness-models-${id}-`));
  const createConnection = opts.createConnection ?? ((agentId, s, cwd) => new AcpAgentConnection({
    id: `model-probe-${agentId}`,
    command: s.command,
    args: s.args,
    cwd,
    fs: false,
    debug: false,
  }));
  const conn = createConnection(id, spec, root);
  try {
    await conn.start();
    await conn.initialize();
    const session = await conn.newSession();
    const result = { models: deriveBaseModels(session), probedAt: now() };
    cache.set(id, result);
    return result;
  } finally {
    conn.kill();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

export function deriveBaseModels(session: unknown): SessionModel[] {
  const configModels = deriveConfigModels(session);
  if (configModels.length) return configModels;
  return deriveStandardModels(session);
}

function deriveConfigModels(session: unknown): SessionModel[] {
  const configOptions = (session as any)?.configOptions;
  if (!Array.isArray(configOptions)) return [];
  const option = configOptions.find((o: any) => o?.category === "model");
  if (!Array.isArray(option?.options)) return [];
  return uniqueModels(option.options.map((m: any) => {
    const id = String(m?.value ?? "");
    if (!id) return undefined;
    return { id, name: String(m?.name ?? m?.value ?? id) };
  }));
}

function deriveStandardModels(session: unknown): SessionModel[] {
  const models = (session as any)?.models;
  if (!Array.isArray(models?.availableModels)) return [];
  return uniqueModels(models.availableModels.map((m: any) => {
    const rawId = String(m?.modelId ?? "");
    if (!rawId) return undefined;
    const id = rawId.replace(EFFORT_SUFFIX, "");
    return { id, name: String(m?.name ?? rawId).replace(EFFORT_SUFFIX, "") };
  }));
}

function uniqueModels(models: Array<SessionModel | undefined>): SessionModel[] {
  const seen = new Set<string>();
  const out: SessionModel[] = [];
  for (const model of models) {
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}
