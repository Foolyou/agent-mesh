// src/mesh-validate.ts
// Deterministic validation of a mesh topology. The control plane runs this over
// every (possibly LLM-generated) MeshConfig before defining/persisting it.
import { HARNESSES } from "./harness";
import { normalizeMeshEdge, normalizeMeshEdges, type AgentConfig, type AgentStatus, type MeshConfig, type MeshEdge, type MeshEdgeInput } from "./acp/types";

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
    if (!a.project) {
      throw new Error(`agent "${a.id}" project is required`);
    }
    if (a.effort !== undefined && !["minimal", "low", "medium", "high"].includes(a.effort)) {
      throw new Error(`agent "${a.id}" has invalid effort "${a.effort}" (use minimal|low|medium|high)`);
    }
    if (a.bypass !== undefined && typeof a.bypass !== "boolean") {
      throw new Error(`agent "${a.id}" bypass must be a boolean`);
    }
    if (a.bypass === true && a.harness === "kimi") {
      throw new Error(`agent "${a.id}" cannot enable bypass: kimi has no bypass mechanism`);
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

export function validateAddAgent(config: MeshConfig, cfg: AgentConfig): AgentConfig {
  const role = cfg.role ?? "member";
  const agent: AgentConfig = role === "member" ? { ...cfg, role, lazy: cfg.lazy ?? true } : { ...cfg, role };
  if (!agent.id || !/^[A-Za-z0-9._-]+$/.test(agent.id) || agent.id.includes("..")) {
    throw new Error(`invalid agent id "${agent.id}": use only letters, digits, '.', '_', '-'`);
  }
  if (config.agents.some((a) => a.id === agent.id)) throw new Error(`duplicate agent id "${agent.id}"`);
  if (!(agent.harness in HARNESSES)) {
    throw new Error(`agent "${agent.id}" has unknown harness "${agent.harness}"`);
  }
  if (!agent.project) {
    throw new Error(`agent "${agent.id}" project is required`);
  }
  if (agent.effort !== undefined && !["minimal", "low", "medium", "high"].includes(agent.effort)) {
    throw new Error(`agent "${agent.id}" has invalid effort "${agent.effort}" (use minimal|low|medium|high)`);
  }
  if (agent.bypass !== undefined && typeof agent.bypass !== "boolean") {
    throw new Error(`agent "${agent.id}" bypass must be a boolean`);
  }
  if (agent.bypass === true && agent.harness === "kimi") {
    throw new Error(`agent "${agent.id}" cannot enable bypass: kimi has no bypass mechanism`);
  }
  if (agent.role === "router") {
    if (config.agents.some((a) => a.role === "router")) {
      throw new Error(`mesh already has a router; cannot add router agent "${agent.id}"`);
    }
    if (agent.lazy === true) {
      throw new Error(`router agent "${agent.id}" cannot be lazy`);
    }
  }
  if (agent.instructions !== undefined) {
    if (typeof agent.instructions !== "string") throw new Error(`agent "${agent.id}" instructions must be a string`);
    const instructions = agent.instructions.trim();
    if (instructions && instructions.length > 4000) {
      throw new Error(`agent "${agent.id}" instructions are too long (max 4000 chars)`);
    }
  }
  return agent;
}
