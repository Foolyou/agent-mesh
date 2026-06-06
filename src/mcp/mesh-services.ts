// Mesh Services: a single HTTP MCP server injected into every agent session.
// Each agent connects at /{agentId}/mcp; the agent's identity is the path
// segment, so tool callbacks know who is calling. Tools delegate to the
// control-plane handlers passed in.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import type { AgentId, AgentRole } from "../acp/types";

export interface MeshToolContext {
  agentId: AgentId;
  role: AgentRole;
}

export interface MeshServicesHandlers {
  meshStatus(ctx: MeshToolContext): Promise<string> | string;
  sendMail(ctx: MeshToolContext, to: string, body: string): Promise<string> | string;
  checkMail(ctx: MeshToolContext): Promise<string> | string;
  interrupt(ctx: MeshToolContext, target: string, reason?: string): Promise<string> | string;
}

export interface MeshServicesServer {
  register(agentId: AgentId, role: AgentRole): Promise<void>;
  urlFor(agentId: AgentId): string;
  readonly port: number;
  close(): void;
}

export function createMeshServicesServer(opts: {
  port?: number;
  host?: string;
  handlers: MeshServicesHandlers;
}): MeshServicesServer {
  const host = opts.host ?? "127.0.0.1";
  const entries = new Map<AgentId, { transport: WebStandardStreamableHTTPServerTransport }>();

  const httpServer = Bun.serve({
    port: opts.port ?? 0,
    hostname: host,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/([^/]+)\/mcp$/);
      if (!match) return new Response("not found", { status: 404 });
      const agentId = decodeURIComponent(match[1]);
      const entry = entries.get(agentId);
      if (!entry) return new Response("unknown agent", { status: 404 });
      return entry.transport.handleRequest(req);
    },
  });

  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  async function register(agentId: AgentId, role: AgentRole): Promise<void> {
    const server = new McpServer({ name: "mesh-services", version: "0.1.0" });
    const ctx: MeshToolContext = { agentId, role };

    server.registerTool(
      "mesh_status",
      { description: "Report the current state of the mesh you belong to." },
      async () => text(await opts.handlers.meshStatus(ctx)),
    );

    server.registerTool(
      "send_mail",
      {
        description:
          "Send an asynchronous message to another agent in your mesh. Delivery is async; you cannot interrupt the recipient.",
        inputSchema: {
          to: z.string().describe("recipient agent id"),
          body: z.string().describe("message body"),
        },
      },
      async ({ to, body }) => text(await opts.handlers.sendMail(ctx, to, body)),
    );

    server.registerTool(
      "check_mail",
      { description: "Read messages other agents have sent you since you last checked." },
      async () => text(await opts.handlers.checkMail(ctx)),
    );

    // Router-only: interrupting another agent's run.
    if (role === "router") {
      server.registerTool(
        "interrupt",
        {
          description:
            "Interrupt (cancel the current turn of) another agent in your mesh. Router-only authority.",
          inputSchema: {
            target: z.string().describe("agent id to interrupt"),
            reason: z.string().optional().describe("why"),
          },
        },
        async ({ target, reason }) => text(await opts.handlers.interrupt(ctx, target, reason)),
      );
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    await server.connect(transport);
    entries.set(agentId, { transport });
  }

  return {
    register,
    urlFor: (agentId) => `http://${host}:${httpServer.port}/${encodeURIComponent(agentId)}/mcp`,
    get port() {
      return httpServer.port;
    },
    close: () => httpServer.stop(true),
  };
}
