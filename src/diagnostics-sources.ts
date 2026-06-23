// src/diagnostics-sources.ts
//
// The REAL data sources that feed the shared diagnostics model (src/diagnostics.ts). Both the CLI
// (mesh ps -v / mesh doctor) and the web system-health panel build their deps from here, so neither
// re-derives logic — they share one set of gatherers. Each gatherer composes an EXISTING module:
//   - harness:  harness-probe.probeHarnesses
//   - config:   mesh-validate.validateMeshConfig (per-file, isolated) + channels readFeishuConfig
//   - backend:  service.backendStatus (record + <500 liveness, same as `mesh up/status`)
//   - auth:     READ-ONLY readiness. It may deserialize the auth-store files via the existing sanitized
//               readers to COUNT entries (those files hold tokenHash/encrypted authcodes), but it emits
//               only counts/booleans + key-store presence — never a tokenHash, encrypted token, AES
//               secret, key id, or any raw credential. The key store is checked by file presence only
//               (existsSync), so no key material is ever loaded.
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
import { validateMeshConfig, collectMeshConfigWarnings } from "./mesh-validate";
import { normalizeMeshEdges, type MeshConfig } from "./acp/types";
import { probeHarnesses } from "./harness-probe";
import { readFeishuConfig } from "./channels/config";
import { backendStatus } from "./service";
import { devicesPath, feishuAuthPath, readDevices, readFeishuAuth } from "./auth-store";
import { authKeysPath } from "./auth-codes";
import { collectProcLeaks, probeBaseDir, type AgentActivityState, type AgentDetail, type AuthReadiness, type ConfigInputs, type DoctorDeps, type HarnessProbeLike, type PsDetailDeps } from "./diagnostics";
import type { MeshHostRecord } from "./mesh-registry";
import type { AgentRole, HarnessId } from "./acp/types";

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
      const normalized = { ...parsed, edges: normalizeMeshEdges((parsed as { edges?: unknown }).edges as never) };
      validateMeshConfig(normalized);
      out.push({ name, ok: true, warnings: collectMeshConfigWarnings(normalized) });
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

// ── auth readiness (read-only) ──────────────────────────────────────────────────
// Deserializes devices.json / feishu.json via the sanitized auth-store readers to COUNT entries —
// those files carry tokenHash/encrypted authcodes, but we keep ONLY the counts. The key store is
// probed by file presence (existsSync) alone, so no key material is loaded. Nothing here returns a
// tokenHash, encrypted token, AES secret, key id, or any raw credential.
export async function authReadiness(root: string): Promise<AuthReadiness> {
  const devPresent = existsSync(devicesPath(root));
  const dev = devPresent ? await readDevices(root) : undefined;
  const fzPresent = existsSync(feishuAuthPath(root));
  const fz = fzPresent ? await readFeishuAuth(root) : undefined;
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
    keys: { present: existsSync(authKeysPath(root)) }, // presence only — never load key material
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

// ── ps-detail (web): live per-agent view enriched from the in-process gateway snapshot ──
//
// The web tier runs WITH the backend, so it already holds live agent status/context — no socket
// connection needed (unlike the CLI). We read a MINIMAL structural slice of the gateway snapshot
// (defined here, not imported from the web layer, so this core module stays free of a web dependency)
// and fall back to the same static config detail when a running mesh isn't in the live snapshot yet
// (e.g. the gateway is still reattaching) so a missing live row never blanks a running mesh.

/** The slice of a live WebGateway snapshot that web ps-detail needs. Structural on purpose. */
export interface LiveSnapshot {
  meshes: ReadonlyArray<{
    name: string;
    agents: ReadonlyArray<{ id: string; harness?: string; role?: string; status?: string; activity?: string }>;
  }>;
  perMesh: Record<string, { usage?: Record<string, { used?: number; size?: number } | undefined> } | undefined>;
}

function liveActivity(a: string | undefined): AgentActivityState {
  return a === "working" ? "working" : a === "idle" ? "idle" : "unknown";
}

/** Context fields from a live usage row, normalized to 0–100 percent. Only counts/percent — never any
 *  token text. Returns {} when usage is missing or malformed so the agent simply omits context. */
function contextFields(u: { used?: number; size?: number } | undefined): Partial<AgentDetail> {
  if (!u || typeof u.used !== "number" || typeof u.size !== "number" || u.size <= 0) return {};
  return {
    contextUsed: u.used,
    contextSize: u.size,
    contextPercent: Math.max(0, Math.min(100, Math.round((u.used / u.size) * 100))),
  };
}

/** PsDetailDeps for the web API: a gateway-backed `agentsFor` that supplies live activity + context,
 *  degrading to the static CLI detail for any running mesh absent from the live snapshot. */
export function webPsSources(root: string, snapshot: LiveSnapshot | undefined): PsDetailDeps {
  const fallback = cliAgentsFor(root);
  return {
    agentsFor: async (record) => {
      const mesh = snapshot?.meshes.find((m) => m.name === record.name);
      if (!mesh) return fallback(record); // not in live state yet → static config detail
      const usage = snapshot?.perMesh?.[record.name]?.usage ?? {};
      return mesh.agents.map((a) => ({
        id: a.id,
        harness: a.harness as HarnessId | undefined,
        role: a.role as AgentRole | undefined,
        activity: liveActivity(a.activity),
        ...(a.status ? { status: a.status } : {}),
        ...contextFields(usage[a.id]),
      }));
    },
  };
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
