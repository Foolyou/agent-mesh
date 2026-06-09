// In-memory fake manager + master for `--fake` mode: drives a scripted scenario
// (streamed messages, a thought, a tool call with status transitions, inter-agent
// mail, a permission escalation, and an interrupt) so every widget can be exercised
// in the browser without spawning real agents. Doubles as a zero-dependency demo.
import type { AgentConfig, MeshConfig, MeshEdge, MeshEvent, AgentId } from "../acp/types";
import { now } from "../acp/types";
import type { MeshStatus } from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DEMO: MeshConfig = {
  name: "demo",
  agents: [
    { id: "router", harness: "claude", project: "test_mesh_0", role: "router" },
    { id: "codex-1", harness: "codex", project: "test_mesh_0", role: "member" },
    { id: "opencode-1", harness: "opencode", project: "test_mesh_0", role: "member" },
  ],
  edges: [
    { from: "router", to: "codex-1" },
    { from: "router", to: "opencode-1" },
    { from: "codex-1", to: "opencode-1" },
    { from: "opencode-1", to: "codex-1" },
  ],
};

interface Entry {
  config: MeshConfig;
  status: MeshStatus;
}

// a realistic ACP session-mode set so the demo exercises the mode picker
const FAKE_MODES = [
  { id: "read-only", name: "read-only", description: "can read files; cannot edit or run commands" },
  { id: "default", name: "default", description: "asks before risky actions" },
  { id: "full-access", name: "full-access", description: "may edit files and run commands freely" },
];
const FAKE_MODELS = [
  { id: "kimi-k2", name: "kimi-k2" },
  { id: "deepseek-v3", name: "deepseek-v3" },
];

export class FakeManager {
  private listeners = new Set<(name: string, e: MeshEvent) => void>();
  private meshes = new Map<string, Entry>();
  /** current mode per `${mesh}:${agent}` so setMode reflects back into the picker */
  private modeOf = new Map<string, string>();
  /** current model per `${mesh}:${agent}` so setModel reflects back into the picker */
  private modelOf = new Map<string, string>();

  constructor() {
    this.meshes.set("demo", { config: DEMO, status: "stopped" });
  }

  on(l: (name: string, e: MeshEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(name: string, e: MeshEvent): void {
    for (const l of this.listeners) l(name, e);
  }
  private update(name: string, agent: AgentId, update: unknown): void {
    this.emit(name, { kind: "update", agent, update, ts: now() });
  }
  private require(name: string): Entry {
    const e = this.meshes.get(name);
    if (!e) throw new Error(`no such mesh "${name}"`);
    return e;
  }

  listMeshes() {
    return [...this.meshes.values()].map((e) => ({ name: e.config.name, defined: true, status: e.status }));
  }
  configOf(name: string): MeshConfig {
    return this.require(name).config;
  }
  routerOf(name: string): string {
    return this.require(name).config.agents.find((a) => a.role === "router")!.id;
  }
  async defineMesh(config: MeshConfig): Promise<void> {
    this.meshes.set(config.name, { config, status: "stopped" });
  }
  async deleteMesh(name: string): Promise<void> {
    const e = this.meshes.get(name);
    if (e && (e.status === "running" || e.status === "starting")) throw new Error(`mesh "${name}" is running`);
    this.meshes.delete(name);
  }
  async loadDefinitions(): Promise<void> {}

  async startMesh(name: string): Promise<void> {
    const e = this.require(name);
    if (e.status === "running" || e.status === "starting") throw new Error(`mesh "${name}" is already running`);
    e.status = "starting";
    for (const a of e.config.agents) {
      if (!a.lazy) this.emit(name, { kind: "agent_status", agent: a.id, status: "spawning", ts: now() });
    }
    await sleep(400);
    for (const a of e.config.agents) {
      if (a.lazy) {
        this.emit(name, { kind: "agent_status", agent: a.id, status: "cold", ts: now() });
        continue;
      }
      this.emit(name, { kind: "agent_status", agent: a.id, status: "ready", ts: now() });
      this.emit(name, { kind: "agent_capabilities", agent: a.id, image: a.id !== "opencode-1", ts: now() });
      // members advertise session modes (the router has none, like real harnesses vary)
      if (a.role !== "router") {
        const cur = this.modeOf.get(`${name}:${a.id}`) ?? "default";
        this.modeOf.set(`${name}:${a.id}`, cur);
        this.emit(name, { kind: "agent_modes", agent: a.id, current: cur, available: FAKE_MODES, ts: now() });
        const model = this.modelOf.get(`${name}:${a.id}`) ?? FAKE_MODELS[0]!.id;
        this.modelOf.set(`${name}:${a.id}`, model);
        this.emit(name, { kind: "agent_models", agent: a.id, current: model, available: FAKE_MODELS, ts: now() });
      }
    }
    e.status = "running";
    this.emit(name, { kind: "log", text: `mesh "${name}" started (fake)`, ts: now() });
    void this.scenario(name);
  }
  wakeAgent(name: string, agentId: string): void {
    const e = this.require(name);
    const a = e.config.agents.find((x) => x.id === agentId);
    if (!a) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    this.emit(name, { kind: "agent_status", agent: agentId, status: "spawning", ts: now() });
    setTimeout(() => {
      this.emit(name, { kind: "agent_status", agent: agentId, status: "ready", ts: now() });
      this.emit(name, { kind: "agent_capabilities", agent: agentId, image: a.id !== "opencode-1", ts: now() });
      this.emit(name, { kind: "log", text: `agent "${agentId}" woken (fake)`, ts: now() });
    }, 200);
  }
  async stopMesh(name: string): Promise<void> {
    const e = this.require(name);
    for (const a of e.config.agents) this.emit(name, { kind: "agent_status", agent: a.id, status: "dead", ts: now() });
    e.status = "stopped";
    this.emit(name, { kind: "log", text: `mesh "${name}" stopped (fake)`, ts: now() });
  }
  async stopAll(): Promise<void> {
    for (const n of this.meshes.keys()) await this.stopMesh(n).catch(() => {});
  }
  /** Fake meshes are in-process, so "disconnect" (leave running) just means stop. */
  disconnectAll(): void {
    void this.stopAll();
  }

  async promptRouter(name: string, text: string, _images = []): Promise<void> {
    void this.reply(name, "router", `Understood — "${text}". Coordinating the members now.`);
  }
  promptAgent(name: string, agentId: string, text: string, _images = []): void {
    void this.reply(name, agentId, `[${agentId}] working on: ${text}`);
  }
  steerAgent(name: string, agentId: string, text: string, _images = []): void {
    this.emit(name, { kind: "steer", from: "operator", to: agentId, body: text, ts: now() });
    void this.reply(name, agentId, `[${agentId}] steering to: ${text}`);
  }
  resolvePermission(name: string, requestId: string, optionId: string): void {
    this.emit(name, { kind: "permission_resolved", agent: "codex-1", requestId, optionId, by: "human", ts: now() });
    void this.reply(name, "codex-1", optionId.includes("allow") ? "Permission granted — running the command." : "Permission denied — skipping that step.");
  }
  async setMode(name: string, agentId: string, modeId: string): Promise<void> {
    this.modeOf.set(`${name}:${agentId}`, modeId);
    this.emit(name, { kind: "log", text: `${agentId} mode → ${modeId}`, ts: now() });
    // echo the new current back so the picker reflects it (mirrors a real current_mode_update)
    this.emit(name, { kind: "agent_modes", agent: agentId, current: modeId, available: FAKE_MODES, ts: now() });
  }
  async setModel(name: string, agentId: string, modelId: string): Promise<void> {
    this.modelOf.set(`${name}:${agentId}`, modelId);
    this.emit(name, { kind: "log", text: `${agentId} model → ${modelId}`, ts: now() });
    this.emit(name, { kind: "agent_models", agent: agentId, current: modelId, available: FAKE_MODELS, ts: now() });
  }
  interruptAgent(name: string, agentId: string): void {
    this.emit(name, { kind: "interrupt", from: "operator", target: agentId, reason: "operator interrupt", ts: now() });
  }
  async newAgentSession(name: string, agentId: string): Promise<void> {
    this.update(name, agentId, { sessionUpdate: "__session_reset__" });
  }
  async newAllSessions(name: string): Promise<void> {
    for (const a of this.require(name).config.agents) this.update(name, a.id, { sessionUpdate: "__session_reset__" });
  }
  async setAgentEffort(name: string, agentId: string, effort?: any): Promise<void> {
    const e = this.require(name);
    e.config = { ...e.config, agents: e.config.agents.map((a) => (a.id === agentId ? { ...a, effort } : a)) };
  }
  async addEdge(name: string, edge: { from: string; to: string; steer?: boolean }): Promise<void> {
    const e = this.require(name);
    if (!e.config.agents.some((a) => a.id === edge.from) || !e.config.agents.some((a) => a.id === edge.to)) {
      throw new Error(`edge ${edge.from}->${edge.to} references an unknown agent`);
    }
    if (e.config.edges.some((x) => x.from === edge.from && x.to === edge.to)) {
      throw new Error(`edge ${edge.from}->${edge.to} already exists`);
    }
    e.config = { ...e.config, edges: [...e.config.edges, { from: edge.from, to: edge.to, steer: edge.steer === true }] };
    this.emit(name, { kind: "log", text: `edge added ${edge.from} -> ${edge.to}`, ts: now() });
  }
  async addAgent(name: string, cfg: AgentConfig, edges: MeshEdge[] = []): Promise<void> {
    const e = this.require(name);
    if (e.config.agents.some((a) => a.id === cfg.id)) throw new Error(`duplicate agent id "${cfg.id}"`);
    if (cfg.role === "router" && e.config.agents.some((a) => a.role === "router")) throw new Error(`mesh already has a router`);
    const agent: AgentConfig = cfg.role === "member" ? { ...cfg, lazy: cfg.lazy ?? true } : { ...cfg };
    const nextEdges = [...e.config.edges];
    for (const edge of edges) {
      if (!e.config.agents.some((a) => a.id === edge.from) && edge.from !== agent.id) throw new Error(`edge ${edge.from}->${edge.to} references an unknown agent`);
      if (!e.config.agents.some((a) => a.id === edge.to) && edge.to !== agent.id) throw new Error(`edge ${edge.from}->${edge.to} references an unknown agent`);
      nextEdges.push({ from: edge.from, to: edge.to, steer: edge.steer === true });
    }
    e.config = { ...e.config, agents: [...e.config.agents, agent], edges: nextEdges };
    if (e.status === "running") {
      this.emit(name, { kind: "agent_status", agent: agent.id, status: "cold", ts: now() });
      this.emit(name, { kind: "agent_activity", agent: agent.id, activity: "idle", ts: now() });
    }
    this.emit(name, { kind: "log", text: `agent added ${agent.id}`, ts: now() });
  }

  /** Stream a short agent message word-by-word, then seal it. */
  private async reply(name: string, agent: AgentId, text: string): Promise<void> {
    if (this.meshes.get(name)?.status !== "running") return;
    for (const w of text.split(" ")) {
      this.update(name, agent, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: w + " " } });
      await sleep(45);
    }
    this.update(name, agent, { sessionUpdate: "__turn_end__" });
  }

  /** The on-start demo: thought → tool call → mail → permission → interrupt. */
  private async scenario(name: string): Promise<void> {
    if (this.meshes.get(name)?.status !== "running") return;
    await sleep(500);
    // router thinks, then streams a plan
    this.update(name, "router", {
      sessionUpdate: "agent_thought_chunk",
      content: { text: "Break the task into **impl** + review and fan out to members." },
    });
    await this.reply(
      name,
      "router",
      [
        "Plan: **codex-1** implements the calculator core, opencode-1 reviews.",
        "- implement core",
        "- review diff",
        "```ts",
        "export const add = (a: number, b: number) => a + b;",
        "```",
        "[safe link](https://example.com) [bad link](javascript:alert(1))",
        "![sample](https://example.com/sample.png) ![bad](javascript:alert(1))",
        // data: image (spec-allowed, must render) next to a data:svg (script-capable, must be blocked)
        "![inline](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==) ![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
        "<u>rawhtml</u> must not become a live element",
      ].join("\n"),
    );

    // a plan checklist (replaced wholesale on each update)
    this.update(name, "router", {
      sessionUpdate: "plan",
      entries: [
        { content: "codex-1: implement calculator core", status: "in_progress", priority: "high" },
        { content: "opencode-1: review the implementation", status: "pending", priority: "medium" },
      ],
    });

    // a tool call on codex-1 that transitions pending → in_progress → completed
    await sleep(300);
    this.update(name, "codex-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tc-build",
      title: "execute: bun test",
      kind: "execute",
      status: "pending",
      rawInput: { command: "bun test", cwd: "test_mesh_0", literal: "**raw input**" },
      locations: [{ path: "src/calc.ts", line: 1 }],
    });
    await sleep(400);
    this.update(name, "codex-1", { sessionUpdate: "tool_call_update", toolCallId: "tc-build", status: "in_progress" });
    await sleep(700);
    this.update(name, "codex-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-build",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "12 pass, 0 fail\n**raw output**" } }],
    });

    // inter-agent mail
    await sleep(300);
    this.emit(name, { kind: "mail", from: "codex-1", to: "opencode-1", body: "core implemented — please review src/calc.ts", ts: now() });
    await this.reply(name, "opencode-1", "Reviewing the diff for codex-1 now…");

    // a permission escalation (resolve from the UI to continue)
    await sleep(400);
    this.emit(name, {
      kind: "permission",
      agent: "codex-1",
      requestId: "perm-shell-1",
      question: "run shell: rm -rf ./build && bun run build ?",
      options: [
        { id: "allow_once", name: "Allow once", kind: "allow_once" },
        { id: "reject_once", name: "Deny", kind: "reject_once" },
      ],
      ts: now(),
    });

    // an interrupt from the router
    await sleep(600);
    this.emit(name, { kind: "interrupt", from: "router", target: "opencode-1", reason: "priorities changed", ts: now() });
  }
}

export class FakeMaster {
  private listeners = new Set<(u: any) => void>();
  on(l: (u: any) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(u: any) {
    for (const l of this.listeners) l(u);
  }
  async prompt(text: string): Promise<unknown> {
    const reply = `On it — interpreting "${text}". I can create_mesh / start_mesh / stop_mesh / list_meshes.`;
    for (const w of reply.split(" ")) {
      this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: w + " " } });
      await sleep(40);
    }
    this.emit({ sessionUpdate: "__turn_end__" });
    return { stopReason: "end_turn" };
  }
  async stop(): Promise<void> {}
}
