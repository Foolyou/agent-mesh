// src/mesh-validate.ts
// Deterministic validation of a mesh topology. The control plane runs this over
// every (possibly LLM-generated) MeshConfig before defining/persisting it.
import { HARNESSES } from "./harness";
import { isEffortSupportedByHarness, isThinkingEffort, supportedEffortsForConfig } from "./harness-utils";
import { normalizeMeshEdge, normalizeMeshEdges, type AgentConfig, type AgentStatus, type MeshConfig, type MeshEdge, type MeshEdgeInput } from "./acp/types";
import { parseCompactThreshold } from "./auto-compact";

function validateAgentEffort(agent: AgentConfig): void {
  if (agent.effort === undefined) return;
  const options = supportedEffortsForConfig(agent.harness);
  if (!isThinkingEffort(agent.effort) || !isEffortSupportedByHarness(agent.harness, agent.effort)) {
    const suffix = options.length > 0 ? `use ${options.join("|")}` : `${agent.harness} does not support effort`;
    throw new Error(`agent "${agent.id}" has invalid effort "${agent.effort}" for ${agent.harness} (${suffix})`);
  }
}

function validateOpencodePermission(agent: AgentConfig): void {
  if (agent.opencodePermission === undefined) return;
  if (agent.opencodePermission !== "allow" && agent.opencodePermission !== "ask") {
    throw new Error(`agent "${agent.id}" opencodePermission must be "allow" or "ask"`);
  }
  if (agent.harness !== "opencode") {
    throw new Error(`agent "${agent.id}" opencodePermission only applies to the opencode harness; other harnesses set permission via mode`);
  }
}

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
    validateAgentEffort(a);
    validateOpencodePermission(a);
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

  if (config.autoCompact !== undefined) {
    if (typeof config.autoCompact !== "object" || config.autoCompact === null || Array.isArray(config.autoCompact)) {
      throw new Error("mesh autoCompact must be an object");
    }
    if (typeof config.autoCompact.enabled !== "boolean") throw new Error("mesh autoCompact.enabled must be a boolean");
    if (typeof config.autoCompact.threshold !== "string") throw new Error("mesh autoCompact.threshold must be a string");
    if (config.autoCompact.enabled === false) return;
    try {
      parseCompactThreshold(config.autoCompact.threshold);
    } catch (err) {
      throw new Error(`mesh autoCompact.threshold is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  validateAgentEffort(agent);
  validateOpencodePermission(agent);
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
