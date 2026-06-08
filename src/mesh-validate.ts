// src/mesh-validate.ts
// Deterministic validation of a mesh topology. The control plane runs this over
// every (possibly LLM-generated) MeshConfig before defining/persisting it.
import { isAbsolute } from "node:path";
import { HARNESSES } from "./harness";
import { normalizeMeshEdge, normalizeMeshEdges, type AgentStatus, type MeshConfig, type MeshEdge, type MeshEdgeInput } from "./acp/types";

export function validateMeshConfig(config: MeshConfig): void {
  const { name, agents } = config;
  const edges = normalizeMeshEdges((config as any).edges ?? []);

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
    if (a.role === "router" && a.lazy === true) {
      throw new Error(`router agent "${a.id}" cannot be lazy`);
    }
    if (a.instructions !== undefined) {
      if (typeof a.instructions !== "string") throw new Error(`agent "${a.id}" instructions must be a string`);
      const instructions = a.instructions.trim();
      if (instructions && instructions.length > 4000) {
        throw new Error(`agent "${a.id}" instructions are too long (max 4000 chars)`);
      }
    }
  }

  const routerId = routers[0]?.id;
  for (const edge of edges) {
    const { from, to, steer } = edge;
    if (!ids.has(from) || !ids.has(to)) {
      throw new Error(`edge [${from}, ${to}] references an unknown agent`);
    }
    if (steer === true && to === routerId) {
      throw new Error(`edge [${from}, ${to}] cannot enable steer to the router`);
    }
  }

  if (config.charter !== undefined) {
    if (typeof config.charter !== "string") throw new Error("mesh charter must be a string");
    if (config.charter.length > 4000) throw new Error("mesh charter is too long (max 4000 chars)");
  }
}

export function validateAddEdge(config: MeshConfig, edgeInput: MeshEdgeInput, statusOf: (id: string) => AgentStatus | undefined = () => undefined): MeshEdge {
  const edge = normalizeMeshEdge(edgeInput);
  const ids = new Set(config.agents.map((a) => a.id));
  if (!ids.has(edge.from) || !ids.has(edge.to)) {
    throw new Error(`edge [${edge.from}, ${edge.to}] references an unknown agent`);
  }
  if (statusOf(edge.to) === "dead") {
    throw new Error(`edge [${edge.from}, ${edge.to}] targets dead agent "${edge.to}"`);
  }
  const routerId = config.agents.find((a) => a.role === "router")?.id;
  if (edge.steer === true && edge.to === routerId) {
    throw new Error(`edge [${edge.from}, ${edge.to}] cannot enable steer to the router`);
  }
  if (normalizeMeshEdges((config as any).edges ?? []).some((e) => e.from === edge.from && e.to === edge.to)) {
    throw new Error(`edge [${edge.from}, ${edge.to}] already exists`);
  }
  return edge;
}
