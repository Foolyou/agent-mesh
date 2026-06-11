// src/mcp/mesh-control.ts
// MCP server injected into the Mesh Assistant: lifecycle tools that wrap the
// deterministic MeshManager. Errors are returned as text so the LLM can correct.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import type { MeshManager } from "../mesh-manager";
import type { StartSessionStrategy } from "../mesh-manager";
import { normalizeMeshEdges, type MeshConfig, type HarnessId } from "../acp/types";
import { HARNESSES } from "../harness";

const harnessIds = Object.keys(HARNESSES) as [HarnessId, ...HarnessId[]];

export interface MeshControlHandlers {
  createMesh(spec: MeshConfig): Promise<string>;
  updateMesh(spec: MeshConfig): Promise<string>;
  deleteMesh(name: string): Promise<string>;
  getMesh(name: string): string;
  startMesh(name: string, sessionStrategy?: StartSessionStrategy): Promise<string>;
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
    async updateMesh(spec) {
      try { await manager.defineMesh(spec); return `updated mesh "${spec.name}"`; }
      catch (e) { return err(e); }
    },
    async deleteMesh(name) {
      try { await manager.deleteMesh(name); return `deleted mesh "${name}"`; }
      catch (e) { return err(e); }
    },
    getMesh(name) {
      try { return JSON.stringify(manager.configOf(name), null, 2); }
      catch (e) { return err(e); }
    },
    async startMesh(name, sessionStrategy) {
      try { await manager.startMesh(name, sessionStrategy === "fresh" ? { sessionStrategy } : undefined); return `started "${name}"${sessionStrategy === "fresh" ? " with fresh sessions" : ""}`; }
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

const effortIds = ["minimal", "low", "medium", "high"] as const;

const agentSchema = z.object({
  id: z.string(),
  harness: z.enum(harnessIds).describe("agent harness type"),
  project: z.string().describe("working directory"),
  role: z.enum(["router", "member"]).describe("'router' (exactly one per mesh) or 'member'"),
  lazy: z.boolean().optional().describe("optional: start this non-router agent only on first mail or manual wake"),
  effort: z.enum(effortIds).optional().describe("optional: reasoning/thinking effort for this agent"),
  bypass: z.boolean().optional().describe("optional: request permission bypass where the harness supports it; kimi is not supported"),
  mode: z.string().optional().describe("optional: runtime-selected session mode cache, applied best-effort after spawn"),
  model: z.string().optional().describe("optional: runtime-selected model cache, applied best-effort after spawn"),
  instructions: z
    .string()
    .optional()
    .describe("optional per-agent instructions injected only into this agent's briefing; omit or set blank to clear"),
});
const edgeSchema = z.union([
  z.tuple([z.string(), z.string()]),
  z.object({
    from: z.string(),
    to: z.string(),
    steer: z.boolean().optional(),
  }),
]);
const toolEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  steer: z.boolean().optional(),
});
const meshSpecShape = {
  name: z.string().describe("unique mesh name (filesystem-safe)"),
  agents: z.array(agentSchema).describe("agents; exactly one must have role 'router'"),
  edges: z
    .array(edgeSchema)
    .describe("directed mail edges — either legacy [from, to] or {from, to, steer?}; both IDs must appear in agents[].id"),
  charter: z
    .string()
    .optional()
    .describe("optional team charter: shared goal + working norms, injected into every agent's briefing; distinct from per-agent instructions, which are private to one agent"),
};
const meshToolSpecShape = {
  ...meshSpecShape,
  edges: z
    .array(toolEdgeSchema)
    .describe("directed mail edges as {from, to, steer?}; both IDs must appear in agents[].id"),
};
const meshSpecSchema = z.object(meshSpecShape);
function parseMeshSpec(spec: unknown): MeshConfig {
  const parsed = meshSpecSchema.parse(spec);
  return { ...parsed, edges: normalizeMeshEdges(parsed.edges) };
}

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

  const server = new McpServer({ name: "mesh-control", version: "0.2.0" });
  server.registerTool("create_mesh",
    { description: "Define a NEW mesh (validated + persisted; does not start it).", inputSchema: meshToolSpecShape },
    async (spec) => text(await opts.handlers.createMesh(parseMeshSpec(spec))));
  server.registerTool("get_mesh",
    { description: "Get a mesh's full definition (agents, edges, project, charter, per-agent instructions) as JSON. Use this before update_mesh to see what to change.", inputSchema: { name: z.string() } },
    async ({ name }) => text(opts.handlers.getMesh(name)));
  server.registerTool("update_mesh",
    { description: "Replace the definition of an existing STOPPED mesh — same shape as create_mesh (validated + persisted). Read it first with get_mesh, change the fields you want, and pass the full updated spec.", inputSchema: meshToolSpecShape },
    async (spec) => text(await opts.handlers.updateMesh(parseMeshSpec(spec))));
  server.registerTool("delete_mesh",
    { description: "Delete a mesh definition permanently. The mesh must be stopped first.", inputSchema: { name: z.string() } },
    async ({ name }) => text(await opts.handlers.deleteMesh(name)));
  server.registerTool("start_mesh",
    { description: "Start a defined mesh (spawns its agents). Use sessionStrategy=fresh to avoid inheriting saved agent sessions.", inputSchema: { name: z.string(), sessionStrategy: z.enum(["resume", "fresh"]).optional() } },
    async ({ name, sessionStrategy }) => text(await opts.handlers.startMesh(name, sessionStrategy)));
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
    get port() { return httpServer.port!; },
    close: () => httpServer.stop(true),
  };
}
