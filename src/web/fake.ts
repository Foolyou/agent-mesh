// In-memory fake manager + master for `--fake` mode: drives a scripted scenario
// (streamed messages, a thought, a tool call with status transitions, inter-agent
// mail, a permission escalation, and an interrupt) so every widget can be exercised
// in the browser without spawning real agents. Doubles as a zero-dependency demo.
import type { MeshConfig, MeshEvent, AgentId } from "../acp/types";
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
    ["router", "codex-1"],
    ["router", "opencode-1"],
    ["codex-1", "opencode-1"],
    ["opencode-1", "codex-1"],
  ],
};

interface Entry {
  config: MeshConfig;
  status: MeshStatus;
}

export class FakeManager {
  private listeners = new Set<(name: string, e: MeshEvent) => void>();
  private meshes = new Map<string, Entry>();

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
    for (const a of e.config.agents) this.emit(name, { kind: "agent_status", agent: a.id, status: "spawning", ts: now() });
    await sleep(400);
    for (const a of e.config.agents) this.emit(name, { kind: "agent_status", agent: a.id, status: "ready", ts: now() });
    e.status = "running";
    this.emit(name, { kind: "log", text: `mesh "${name}" started (fake)`, ts: now() });
    void this.scenario(name);
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

  async promptRouter(name: string, text: string): Promise<void> {
    void this.reply(name, "router", `Understood — "${text}". Coordinating the members now.`);
  }
  promptAgent(name: string, agentId: string, text: string): void {
    void this.reply(name, agentId, `[${agentId}] working on: ${text}`);
  }
  resolvePermission(name: string, requestId: string, optionId: string): void {
    this.emit(name, { kind: "permission_resolved", agent: "codex-1", requestId, optionId, by: "human", ts: now() });
    void this.reply(name, "codex-1", optionId.includes("allow") ? "Permission granted — running the command." : "Permission denied — skipping that step.");
  }
  setMode(name: string, agentId: string, modeId: string): void {
    this.emit(name, { kind: "log", text: `${agentId} mode → ${modeId}`, ts: now() });
  }
  interruptAgent(name: string, agentId: string): void {
    this.emit(name, { kind: "interrupt", from: "operator", target: agentId, reason: "operator interrupt", ts: now() });
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
    this.update(name, "router", { sessionUpdate: "agent_thought_chunk", content: { text: "Break the task into impl + review and fan out to members." } });
    await this.reply(name, "router", "Plan: codex-1 implements the calculator core, opencode-1 reviews.");

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
      rawInput: { command: "bun test", cwd: "test_mesh_0" },
      locations: [{ path: "src/calc.ts", line: 1 }],
    });
    await sleep(400);
    this.update(name, "codex-1", { sessionUpdate: "tool_call_update", toolCallId: "tc-build", status: "in_progress" });
    await sleep(700);
    this.update(name, "codex-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-build",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "12 pass, 0 fail" } }],
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
}
