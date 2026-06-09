import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { AgentId, AgentRole, MeshConfig } from "./acp/types";
import type { MeshServicesHandlers, MeshServicesServer } from "./mcp/mesh-services";
import { ControlPlane } from "./control-plane";

// Minimal ACP connection stub: each (re)spawn makes a fresh instance.
class StubConnection {
  supportsLoadSession = true;
  kills = 0;
  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } };
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `new-${this.opts.id}-${Math.random()}`, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } };
  }
  async loadSession(sessionId: string): Promise<unknown> {
    return { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } };
  }
  async prompt(): Promise<unknown> { return { stopReason: "end_turn" }; }
  async steerPrompt(): Promise<unknown> { return { stopReason: "end_turn" }; }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void { this.kills++; }
}

// Spy mesh-services that records every register() call (and how many transports it closed).
class SpyMeshServices implements MeshServicesServer {
  registerCalls: AgentId[] = [];
  closedTransports = 0;
  constructor(readonly handlers: MeshServicesHandlers) {}
  async register(agentId: AgentId, _role: AgentRole): Promise<void> {
    if (this.registerCalls.includes(agentId)) this.closedTransports++;
    this.registerCalls.push(agentId);
  }
  urlFor(agentId: AgentId): string { return `http://127.0.0.1:0/${agentId}/mcp`; }
  get port(): number { return 0; }
  close(): void {}
}

test("re-spawning an agent re-registers its mesh MCP transport so the new process can re-handshake", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-mcp-reregister-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "reg",
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
  };
  let spy: SpyMeshServices | undefined;
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => new StubConnection(opts) as unknown as AcpAgentConnection,
    meshServicesFactory: (handlers) => (spy = new SpyMeshServices(handlers)),
  });
  try {
    await cp.start(); // initial spawn → register once
    expect(spy!.registerCalls).toEqual(["router"]);
    await cp.newSession("router"); // forceFresh respawn → MUST re-register
    // Without re-registration the new agent process hits a stale, already-initialized
    // MCP transport ("Server already initialized") and silently comes back tool-less.
    expect(spy!.registerCalls).toEqual(["router", "router"]);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
