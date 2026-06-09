// src/master-agent.ts
// Optional LLM control layer: a configurable ACP agent whose only tools are the
// mesh-control lifecycle tools. The system runs fully without it.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AcpAgentConnection, type AcpConnectionOptions } from "./acp/client";
import type { HarnessId, PromptImageRef } from "./acp/types";
import { resolveHarness } from "./harness";
import { createMeshControlHandlers, createMeshControlServer, type MeshControlServer } from "./mcp/mesh-control";
import type { MeshManager } from "./mesh-manager";

export class MasterAgent {
  private conn?: AcpAgentConnection;
  private mcp?: MeshControlServer;
  private listeners = new Set<(u: any) => void>();
  /** Whether the master agent advertised image input (promptCapabilities.image). */
  private imageCap = false;
  private _busy = false;

  constructor(
    private manager: MeshManager,
    private opts: {
      project?: string;
      cwd?: string;
      onUpdate?: (u: any) => void;
      debug?: boolean;
      uploadRoot?: string;
      onCapabilities?: (caps: { image: boolean }) => void;
      harness?: HarnessId;
      connectionFactory?: (opts: AcpConnectionOptions) => AcpAgentConnection;
    } = {},
  ) {}

  /** Whether the master agent has an in-flight turn. */
  get busy(): boolean {
    return this._busy;
  }

  /** Subscribe to the master agent's streamed session updates. */
  on(listener: (u: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.mcp = await createMeshControlServer({ handlers: createMeshControlHandlers(this.manager) });
    try {
      const spec = resolveHarness(this.opts.harness ?? "codex");
      const cwd = this.opts.cwd
        ? resolve(this.opts.cwd)
        : this.opts.project
          ? resolve(process.cwd(), this.opts.project)
          : resolve(process.cwd(), ".");
      if (this.opts.cwd) await mkdir(cwd, { recursive: true });
      const connectionFactory = this.opts.connectionFactory ?? ((connOpts: AcpConnectionOptions) => new AcpAgentConnection(connOpts));
      this.conn = connectionFactory({
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
      const initRes = await this.conn.initialize();
      await this.conn.newSession([{ type: "http", name: "mesh-control", url: this.mcp.url, headers: [] }]);
      this.imageCap = !!(initRes as any)?.agentCapabilities?.promptCapabilities?.image;
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
    this._busy = true;
    const imgs = this.imageCap ? images : [];
    return this.conn.prompt(text, imgs.map((i) => ({ ...i, path: i.path ?? (this.opts.uploadRoot && i.bucket ? `${this.opts.uploadRoot}/${i.bucket}/${i.id}` : undefined) }))).finally(() => {
      this._busy = false;
    });
  }

  /** Cancel the master agent's current in-flight turn. No-op when idle. */
  cancel(): void {
    if (!this.conn || !this._busy) return;
    this.conn.cancel().catch(() => {});
  }

  async stop(): Promise<void> {
    this.conn?.kill();
    this.mcp?.close();
  }
}
