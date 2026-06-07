// src/master-agent.ts
// Optional LLM control layer: a claude ACP agent whose only tools are the
// mesh-control lifecycle tools. The system runs fully without it.
import { resolve } from "node:path";
import { AcpAgentConnection } from "./acp/client";
import type { PromptImageRef } from "./acp/types";
import { resolveHarness } from "./harness";
import { createMeshControlHandlers, createMeshControlServer, type MeshControlServer } from "./mcp/mesh-control";
import type { MeshManager } from "./mesh-manager";

export class MasterAgent {
  private conn?: AcpAgentConnection;
  private mcp?: MeshControlServer;
  private listeners = new Set<(u: any) => void>();
  /** Whether the master agent advertised image input (promptCapabilities.image). */
  private imageCap = false;

  constructor(
    private manager: MeshManager,
    private opts: { project?: string; onUpdate?: (u: any) => void; debug?: boolean; uploadRoot?: string; onCapabilities?: (caps: { image: boolean }) => void } = {},
  ) {}

  /** Subscribe to the master agent's streamed session updates. */
  on(listener: (u: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.mcp = await createMeshControlServer({ handlers: createMeshControlHandlers(this.manager) });
    try {
      const spec = resolveHarness("claude");
      const cwd = resolve(process.cwd(), this.opts.project ?? ".");
      this.conn = new AcpAgentConnection({
        id: "master",
        command: spec.command,
        args: spec.args,
        cwd,
        debug: this.opts.debug ?? false,
        onUpdate: (u) => {
          this.opts.onUpdate?.(u);
          for (const l of this.listeners) l(u);
        },
      });
      await this.conn.start();
      await this.conn.initialize();
      const session = await this.conn.newSession([{ type: "http", name: "mesh-control", url: this.mcp.url, headers: [] }]);
      this.imageCap = !!(session as any)?.promptCapabilities?.image;
      this.opts.onCapabilities?.({ image: this.imageCap });
    } catch (err) {
      this.conn?.kill();
      this.conn = undefined;
      this.mcp.close();
      this.mcp = undefined;
      throw err;
    }
  }

  /** Feed a natural-language instruction to the master agent. Image blocks are dropped if the
   *  master agent did not advertise image input (otherwise the turn would be rejected). */
  prompt(text: string, images: PromptImageRef[] = []): Promise<unknown> {
    if (!this.conn) throw new Error("master agent not started");
    const imgs = this.imageCap ? images : [];
    return this.conn.prompt(text, imgs.map((i) => ({ ...i, path: i.path ?? (this.opts.uploadRoot && i.bucket ? `${this.opts.uploadRoot}/${i.bucket}/${i.id}` : undefined) })));
  }

  async stop(): Promise<void> {
    this.conn?.kill();
    this.mcp?.close();
  }
}
