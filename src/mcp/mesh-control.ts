// src/mcp/mesh-control.ts
// MCP server injected into the master agent: lifecycle tools that wrap the
// deterministic MeshManager. Errors are returned as text so the LLM can correct.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import type { MeshManager } from "../mesh-manager";
import type { MeshConfig } from "../acp/types";

export interface MeshControlHandlers {
  createMesh(spec: MeshConfig): Promise<string>;
  startMesh(name: string): Promise<string>;
  stopMesh(name: string): Promise<string>;
  listMeshes(): string;
}

export function createMeshControlHandlers(manager: MeshManager): MeshControlHandlers {
  const err = (e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`;
  return {
    async createMesh(spec) {
      try { await manager.defineMesh(spec); return `created mesh "${spec.name}"`; }
      catch (e) { return err(e); }
    },
    async startMesh(name) {
      try { await manager.startMesh(name); return `started "${name}"`; }
      catch (e) { return err(e); }
    },
    async stopMesh(name) {
      try { await manager.stopMesh(name); return `stopped "${name}"`; }
      catch (e) { return err(e); }
    },
    listMeshes() {
      const rows = manager.listMeshes();
      if (rows.length === 0) return "no meshes defined";
      return rows.map((r) => `- ${r.name} [${r.status}] router=${manager.routerOf(r.name)}`).join("\n");
    },
  };
}

const agentSchema = z.object({
  id: z.string(),
  harness: z.enum(["codex", "opencode", "claude"]).describe("agent harness type"),
  project: z.string().describe("relative working directory"),
  role: z.enum(["router", "member"]).describe("'router' (exactly one per mesh) or 'member'"),
});
const meshSpecShape = {
  name: z.string().describe("unique mesh name (filesystem-safe)"),
  agents: z.array(agentSchema).describe("agents; exactly one must have role 'router'"),
  edges: z
    .array(z.tuple([z.string(), z.string()]))
    .describe("directed [from, to] mail edges — both IDs must appear in agents[].id"),
};
const meshSpecSchema = z.object(meshSpecShape);

export interface MeshControlServer {
  readonly url: string;
  readonly port: number;
  close(): void;
}

export async function createMeshControlServer(opts: {
  handlers: MeshControlHandlers;
  port?: number;
  host?: string;
}): Promise<MeshControlServer> {
  const host = opts.host ?? "127.0.0.1";
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  const server = new McpServer({ name: "mesh-control", version: "0.1.0" });
  server.registerTool("create_mesh",
    { description: "Define a new mesh (validated + persisted; does not start it).", inputSchema: meshSpecShape },
    async (spec) => text(await opts.handlers.createMesh(meshSpecSchema.parse(spec))));
  server.registerTool("start_mesh",
    { description: "Start a defined mesh (spawns its agents).", inputSchema: { name: z.string() } },
    async ({ name }) => text(await opts.handlers.startMesh(name)));
  server.registerTool("stop_mesh",
    { description: "Stop a running mesh (terminates its agents).", inputSchema: { name: z.string() } },
    async ({ name }) => text(await opts.handlers.stopMesh(name)));
  server.registerTool("list_meshes",
    { description: "List all defined meshes and their status." },
    async () => text(opts.handlers.listMeshes()));

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const httpServer = Bun.serve({
    port: opts.port ?? 0,
    hostname: host,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
      return transport.handleRequest(req);
    },
  });

  return {
    get url() { return `http://${host}:${httpServer.port}/mcp`; },
    get port() { return httpServer.port; },
    close: () => httpServer.stop(true),
  };
}
