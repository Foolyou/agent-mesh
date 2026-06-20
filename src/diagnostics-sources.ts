// src/diagnostics-sources.ts
//
// The REAL data sources that feed the shared diagnostics model (src/diagnostics.ts). Both the CLI
// (mesh ps -v / mesh doctor) and the web system-health panel build their deps from here, so neither
// re-derives logic — they share one set of gatherers. Each gatherer composes an EXISTING module:
//   - harness:  harness-probe.probeHarnesses
//   - config:   mesh-validate.validateMeshConfig (per-file, isolated) + channels readFeishuConfig
//   - backend:  service.backendStatus (record + <500 liveness, same as `mesh up/status`)
//   - auth:     auth-store / auth-codes READ-ONLY presence + counts (never reads/emits hashes or keys)
//   - process:  diagnostics.collectProcLeaks (read-only registry scan)
//   - base dir: diagnostics.probeBaseDir (real access(W_OK))
//
// Live per-agent status (busy/idle, context, pid) is intentionally NOT fetched here for the CLI: a
// mesh-host daemon serves ONE client at a time and a new connection destroys the existing one
// (mesh-host.ts), so a standalone `mesh ps` connecting would kick the live backend off its own mesh.
// The CLI therefore reports STATIC per-agent detail (id/harness/role from the mesh config; activity
// "unknown"). The web panel — which runs WITH the backend and already holds live state — supplies a
// richer `agentsFor` from the gateway snapshot (its own commit), through the same shared model.

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateMeshConfig } from "./mesh-validate";
import { normalizeMeshEdges, type MeshConfig } from "./acp/types";
import { probeHarnesses } from "./harness-probe";
import { readFeishuConfig } from "./channels/config";
import { backendStatus } from "./service";
import { devicesPath, feishuAuthPath, readDevices, readFeishuAuth } from "./auth-store";
import { authKeysPath, loadKeys } from "./auth-codes";
import { collectProcLeaks, probeBaseDir, type AgentDetail, type AuthReadiness, type ConfigInputs, type DoctorDeps, type HarnessProbeLike, type PsDetailDeps } from "./diagnostics";
import type { MeshHostRecord } from "./mesh-registry";

const meshesDir = (root: string) => join(root, "meshes");
export const diagnosticsRunDir = (root: string) => join(root, "run");

// ── harness ──────────────────────────────────────────────────────────────────
async function harnessProbes(): Promise<HarnessProbeLike[]> {
  const rows = await probeHarnesses();
  return rows.map((r) => ({ id: r.id, label: r.label, installed: r.installed, version: r.version, toolVersion: r.toolVersion, outdated: r.outdated, auth: r.auth, error: r.error }));
}

// ── config (per-file validation so one bad file doesn't hide the rest) ──────────
export async function meshConfigChecks(root: string): Promise<ConfigInputs["meshes"]> {
  let files: string[];
  try {
    files = (await readdir(meshesDir(root))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ConfigInputs["meshes"] = [];
  for (const f of files.sort()) {
    const name = f.slice(0, -5);
    try {
      const parsed = JSON.parse(await readFile(join(meshesDir(root), f), "utf8")) as MeshConfig;
      validateMeshConfig({ ...parsed, edges: normalizeMeshEdges((parsed as { edges?: unknown }).edges as never) });
      out.push({ name, ok: true });
    } catch (e) {
      out.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

async function configInputs(root: string): Promise<ConfigInputs> {
  const meshes = await meshConfigChecks(root);
  const f = readFeishuConfig(root);
  const feishu = f.exists
    ? { configured: f.configured, enabled: f.enabled, bindings: f.config?.bindings.length ?? 0, reason: f.reason }
    : { configured: false, enabled: false, bindings: 0 };
  return { meshes, feishu };
}

// ── auth (read-only presence + counts; never reads/emits a hash, token, or key) ──
export async function authReadiness(root: string): Promise<AuthReadiness> {
  const devPresent = existsSync(devicesPath(root));
  const dev = devPresent ? await readDevices(root) : undefined;
  const fzPresent = existsSync(feishuAuthPath(root));
  const fz = fzPresent ? await readFeishuAuth(root) : undefined;
  const keysPresent = existsSync(authKeysPath(root));
  const keys = keysPresent ? await loadKeys(root) : undefined;
  return {
    devices: {
      present: devPresent,
      approved: dev ? Object.values(dev.devices).filter((d) => d.status === "approved").length : 0,
      pending: dev ? Object.keys(dev.pending).length : 0,
    },
    feishu: {
      present: fzPresent,
      approved: fz ? Object.values(fz.allow).filter((e) => e.status === "approved").length : 0,
      pending: fz ? Object.keys(fz.pending).length : 0,
    },
    keys: { present: keysPresent, activeKid: keys?.active }, // kid is a key id like "k1", not the secret
  };
}

// ── ps-detail (CLI): static per-agent view from the mesh config — never touches the socket ──
function cliAgentsFor(root: string): (record: MeshHostRecord) => Promise<AgentDetail[]> {
  return async (record) => {
    try {
      const parsed = JSON.parse(await readFile(join(meshesDir(root), `${record.name}.json`), "utf8")) as MeshConfig;
      return (parsed.agents ?? []).map((a) => ({ id: a.id, harness: a.harness, role: a.role, activity: "unknown" as const }));
    } catch {
      return []; // best-effort: no config / parse error → no agent detail (mesh still lists as running)
    }
  };
}

/** PsDetailDeps for the standalone CLI: default read-only registry scan + static agent detail. */
export function cliPsSources(root: string): PsDetailDeps {
  return { agentsFor: cliAgentsFor(root) };
}

/** DoctorDeps wired to the real modules. `port` is the backend port to probe (default 10010). */
export function doctorSources(root: string, port = 10010): DoctorDeps {
  return {
    harnessProbes,
    configInputs: () => configInputs(root),
    backendStatus: () => backendStatus(root, port),
    authReadiness: () => authReadiness(root),
    baseDir: () => probeBaseDir(root),
    procLeaks: () => collectProcLeaks(diagnosticsRunDir(root)),
  };
}
