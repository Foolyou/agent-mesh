// src/mesh-validate.ts
// Deterministic validation of a mesh topology. The control plane runs this over
// every (possibly LLM-generated) MeshConfig before defining/persisting it.
import { isAbsolute } from "node:path";
import { HARNESSES, HARNESS_MODES, UNSAFE_MODES } from "./harness";
import type { MeshConfig } from "./acp/types";

export function validateMeshConfig(config: MeshConfig): void {
  const { name, agents, edges } = config;

  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
    throw new Error(`invalid mesh name "${name}": use only letters, digits, '.', '_', '-'`);
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error("mesh must have at least one agent");
  }

  const routers = agents.filter((a) => a.role === "router");
  if (routers.length !== 1) {
    throw new Error(`mesh must have exactly one router (found ${routers.length})`);
  }

  const ids = new Set<string>();
  for (const a of agents) {
    if (!(a.harness in HARNESSES)) {
      throw new Error(`agent "${a.id}" has unknown harness "${a.harness}"`);
    }
    if (ids.has(a.id)) throw new Error(`duplicate agent id "${a.id}"`);
    ids.add(a.id);
    if (!a.project || isAbsolute(a.project)) {
      throw new Error(`agent "${a.id}" project must be a relative path (got "${a.project}")`);
    }
    if (a.effort !== undefined && !["minimal", "low", "medium", "high"].includes(a.effort)) {
      throw new Error(`agent "${a.id}" has invalid effort "${a.effort}" (use minimal|low|medium|high)`);
    }
    // A configured initial mode must be a known mode id for the harness (no arbitrary strings),
    // and a permission-bypassing mode may only be PRE-ARMED at create time with an explicit opt-in
    // (the operator can still switch to it deliberately at runtime). This blocks an LLM-generated
    // or API config from silently launching an agent into a no-prompt, auto-approve state.
    if (a.mode !== undefined) {
      if (typeof a.mode !== "string" || !a.mode.trim()) throw new Error(`agent "${a.id}" mode must be a non-empty string`);
      if (!(HARNESS_MODES[a.harness] ?? []).includes(a.mode)) {
        throw new Error(`agent "${a.id}" mode "${a.mode}" is not a known ${a.harness} mode`);
      }
      if (UNSAFE_MODES.has(a.mode) && !process.env.ALLOW_UNSAFE_MESH_MODES) {
        throw new Error(`agent "${a.id}" mode "${a.mode}" disables permission prompts; set ALLOW_UNSAFE_MESH_MODES=1 to pre-arm it (or switch to it at runtime)`);
      }
    }
  }

  for (const [from, to] of edges ?? []) {
    if (!ids.has(from) || !ids.has(to)) {
      throw new Error(`edge [${from}, ${to}] references an unknown agent`);
    }
  }

  if (config.charter !== undefined) {
    if (typeof config.charter !== "string") throw new Error("mesh charter must be a string");
    if (config.charter.length > 4000) throw new Error("mesh charter is too long (max 4000 chars)");
  }
}
