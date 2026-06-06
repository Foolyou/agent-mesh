// src/master-agent.ts
// Optional LLM control layer: a claude ACP agent whose only tools are the
// mesh-control lifecycle tools. The system runs fully without it.
import { resolve } from "node:path";
import { AcpAgentConnection } from "./acp/client";
import { resolveHarness } from "./harness";
import { createMeshControlHandlers, createMeshControlServer, type MeshControlServer } from "./mcp/mesh-control";
import type { MeshManager } from "./mesh-manager";

export class MasterAgent {
  private conn?: AcpAgentConnection;
  private mcp?: MeshControlServer;

  constructor(
    private manager: MeshManager,
    private opts: { project?: string; onUpdate?: (u: any) => void; debug?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    this.mcp = await createMeshControlServer({ handlers: createMeshControlHandlers(this.manager) });
    const spec = resolveHarness("claude");
    const cwd = resolve(process.cwd(), this.opts.project ?? ".");
    this.conn = new AcpAgentConnection({
      id: "master",
      command: spec.command,
      args: spec.args,
      cwd,
      debug: this.opts.debug ?? false,
      onUpdate: (u) => this.opts.onUpdate?.(u),
    });
    await this.conn.start();
    await this.conn.initialize();
    await this.conn.newSession([{ type: "http", name: "mesh-control", url: this.mcp.url, headers: [] }]);
  }

  /** Feed a natural-language instruction to the master agent. */
  prompt(text: string): Promise<unknown> {
    if (!this.conn) throw new Error("master agent not started");
    return this.conn.prompt(text);
  }

  async stop(): Promise<void> {
    this.conn?.kill();
    this.mcp?.close();
  }
}
