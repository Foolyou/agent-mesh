// Mesh: pure model of a mesh's membership, the Router (gateway) designation,
// the directed interaction graph (who may mail whom), and per-agent liveness.
import { normalizeMeshEdges, type AgentConfig, type AgentId, type AgentStatus, type MeshConfig } from "./acp/types";

export class Mesh {
  readonly config: MeshConfig;
  private statuses = new Map<AgentId, AgentStatus>();

  constructor(config: MeshConfig) {
    this.config = { ...config, edges: normalizeMeshEdges((config as any).edges) };
    for (const a of config.agents) this.statuses.set(a.id, "spawning");
  }

  get name(): string {
    return this.config.name;
  }

  /** Optional shared team charter (goal + norms), injected into every briefing. */
  get charter(): string | undefined {
    return this.config.charter?.trim() || undefined;
  }

  get router(): AgentConfig {
    const r = this.config.agents.find((a) => a.role === "router");
    if (!r) throw new Error(`mesh ${this.config.name} has no router`);
    return r;
  }

  get members(): AgentConfig[] {
    return this.config.agents.filter((a) => a.role === "member");
  }

  get agents(): AgentConfig[] {
    return this.config.agents;
  }

  agent(id: AgentId): AgentConfig | undefined {
    return this.config.agents.find((a) => a.id === id);
  }

  /** May `from` send mail to `to`? Directed edge must exist and both must be members of the mesh. */
  canMail(from: AgentId, to: AgentId): boolean {
    if (!this.agent(from) || !this.agent(to)) return false;
    return this.config.edges.some((edge) => edge.from === from && edge.to === to);
  }

  canSteer(from: AgentId, to: AgentId): boolean {
    if (from === to) return false;
    if (this.router.id === to) return false;
    if (!this.agent(from) || !this.agent(to)) return false;
    return this.config.edges.some((edge) => edge.from === from && edge.to === to && edge.steer === true);
  }

  setStatus(id: AgentId, status: AgentStatus): void {
    this.statuses.set(id, status);
  }

  status(id: AgentId): AgentStatus | undefined {
    return this.statuses.get(id);
  }
}
