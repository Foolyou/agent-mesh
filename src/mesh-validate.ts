// src/mesh-validate.ts
// Deterministic validation of a mesh topology. The control plane runs this over
// every (possibly LLM-generated) MeshConfig before defining/persisting it.
import { isAbsolute } from "node:path";
import { HARNESSES } from "./harness";
import type { MeshConfig } from "./acp/types";

export function validateMeshConfig(config: MeshConfig): void {
  const { name, agents, edges } = config;

  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
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
  }

  for (const [from, to] of edges ?? []) {
    if (!ids.has(from) || !ids.has(to)) {
      throw new Error(`edge [${from}, ${to}] references an unknown agent`);
    }
  }
}
