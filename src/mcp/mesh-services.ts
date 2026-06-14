// Mesh Services: a single HTTP MCP server injected into every agent session.
// Each agent connects at /{agentId}/mcp; the agent's identity is the path
// segment, so tool callbacks know who is calling. Tools delegate to the
// control-plane handlers passed in.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AgentId, AgentRole } from "../acp/types";

export interface MeshToolContext {
  agentId: AgentId;
  role: AgentRole;
}

export interface SendMailOptions {
  replyTo?: number;
  task?: string;
}

export interface PublishAttachmentOptions {
  caption?: string;
  name?: string;
}

export interface MeshServicesHandlers {
  meshStatus(ctx: MeshToolContext): Promise<string> | string;
  meshBriefing(ctx: MeshToolContext): Promise<string> | string;
  sendMail(ctx: MeshToolContext, to: string, body: string, opts?: SendMailOptions): Promise<string> | string;
  steerMail(ctx: MeshToolContext, to: string, body: string): Promise<string> | string;
  steerTargets(ctx: MeshToolContext): Promise<string[]> | string[];
  checkMail(ctx: MeshToolContext): Promise<string> | string;
  interrupt(ctx: MeshToolContext, target: string, reason?: string): Promise<string> | string;
  publishAttachment(ctx: MeshToolContext, path: string, opts?: PublishAttachmentOptions): Promise<string> | string;
}

export interface MeshServicesServer {
  register(agentId: AgentId, role: AgentRole): Promise<void>;
  urlFor(agentId: AgentId): string;
  readonly port: number;
  close(): void;
}

export interface MeshToolLogEntry {
  event: "tool_start" | "tool_end";
  agent: AgentId;
  tool: string;
  requestId: string;
  ts: string;
  durationMs?: number;
  ok?: boolean;
  error?: string;
}

export function createMeshServicesServer(opts: {
  port?: number;
  host?: string;
  handlers: MeshServicesHandlers;
  /** Structured per-tool-call log sink; defaults to a JSON line on stderr. */
  log?: (entry: MeshToolLogEntry) => void;
  /** A tool handler exceeding this returns an explicit error instead of pending forever. */
  toolTimeoutMs?: number;
}): MeshServicesServer {
  const host = opts.host ?? "127.0.0.1";
  const log = opts.log ?? ((entry: MeshToolLogEntry) => console.error(`[mesh-services] ${JSON.stringify(entry)}`));
  const toolTimeoutMs = opts.toolTimeoutMs ?? 10_000;
  let requestSeq = 0;
  // Registration only records who may connect; servers are built per request.
  // Harnesses open MULTIPLE MCP sessions per agent process (claude runs an internal
  // probe session before the real one, plus reconnects/respawns), so the tool server
  // must be stateless: a single stateful transport rejects every initialize after the
  // first with "Server already initialized", silently stripping the agent's mesh tools.
  const entries = new Map<AgentId, { role: AgentRole; steerTargets: string[] }>();

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
      // Stateless mode requires a fresh transport (and thus server) per request.
      const server = buildServer(agentId, entry);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(req);
      } finally {
        queueMicrotask(() => {
          void server.close().catch(() => {});
          void transport.close().catch(() => {});
        });
      }
    },
  });

  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  /** Run a tool handler with structured start/end logging and a local timeout, so a
   *  stuck control plane surfaces as a fast explicit error instead of a hung MCP call. */
  async function guarded(agentId: AgentId, tool: string, run: () => Promise<string> | string) {
    const requestId = `${agentId}-${tool}-${++requestSeq}`;
    const startedAt = Date.now();
    log({ event: "tool_start", agent: agentId, tool, requestId, ts: new Date().toISOString() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${tool} timed out after ${toolTimeoutMs}ms`)), toolTimeoutMs);
        }),
      ]);
      log({ event: "tool_end", agent: agentId, tool, requestId, ts: new Date().toISOString(), durationMs: Date.now() - startedAt, ok: true });
      return text(result);
    } catch (err) {
      log({
        event: "tool_end",
        agent: agentId,
        tool,
        requestId,
        ts: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        ok: false,
        error: String(err),
      });
      return text(`error: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function buildServer(agentId: AgentId, entry: { role: AgentRole; steerTargets: string[] }): McpServer {
    const { role, steerTargets } = entry;
    const server = new McpServer({ name: "mesh-services", version: "0.2.0" });
    const ctx: MeshToolContext = { agentId, role };

    server.registerTool(
      "mesh_status",
      { description: "Report the current state of the mesh you belong to, including each peer's busy/idle activity." },
      () => guarded(agentId, "mesh_status", () => opts.handlers.meshStatus(ctx)),
    );

    server.registerTool(
      "mesh_briefing",
      {
        description:
          "Re-read your full mesh briefing: live roster, communication rules, team charter, and your " +
          "role instructions. Call this whenever you are unsure of the collaboration rules — e.g. after " +
          "a long session or context compaction. Always reflects the current mesh configuration.",
      },
      () => guarded(agentId, "mesh_briefing", () => opts.handlers.meshBriefing(ctx)),
    );

    server.registerTool(
      "send_mail",
      {
        description:
          "Send a message to another agent in your mesh. Delivery is PUSH: the recipient is woken " +
          "automatically, and their reply will wake you the same way — so to wait for a reply, end " +
          "your turn after sending; never poll. Start the body with [REQ] (needs an answer), [FYI] " +
          "(no reply expected), or [DONE] (deliverable report).",
        inputSchema: {
          to: z.string().describe("recipient agent id"),
          body: z.string().describe("message body; start with [REQ], [FYI] or [DONE]"),
          reply_to: z.number().optional().describe("the #number of the mail you are replying to"),
          task: z.string().optional().describe("task slug this mail belongs to, when your mesh tracks tasks"),
        },
      },
      ({ to, body, reply_to, task }) =>
        guarded(agentId, "send_mail", () => opts.handlers.sendMail(ctx, to, body, { replyTo: reply_to, task })),
    );

    server.registerTool(
      "steer_mail",
      {
        description:
          steerTargets.length > 0
            ? `Interrupt and steer one of these permitted recipients: ${steerTargets.join(", ")}. Use send_mail instead for ordinary queued delivery.`
            : "Interrupt and steer another agent. Current mesh policy gives you no permitted steer targets; use send_mail for ordinary queued delivery.",
        inputSchema: {
          to: z.string().describe("recipient agent id"),
          body: z.string().describe("message body"),
        },
      },
      ({ to, body }) => guarded(agentId, "steer_mail", () => opts.handlers.steerMail(ctx, to, body)),
    );

    server.registerTool(
      "check_mail",
      {
        description:
          "Drain backlogged mail addressed to you. New mail is normally PUSHED to you as a prompt — " +
          "you do NOT need to poll this tool, and waiting for a reply means ending your turn, not " +
          "calling this in a loop. Call it only when told you have pending mail (e.g. right after " +
          "spawning) or when a previous call reported more messages pending. Unsure of the rules? " +
          "Call mesh_briefing.",
      },
      () => guarded(agentId, "check_mail", () => opts.handlers.checkMail(ctx)),
    );

    server.registerTool(
      "mesh_publish_attachment",
      {
        description:
          "Publish a file you wrote under your $AGENT_MESH_ARTIFACTS directory as a first-class " +
          "attachment card in your conversation, so the user sees the image/document directly " +
          "without you having to write any Markdown. Pass `path` relative to your artifacts dir. " +
          "Ownership is fixed to you — you cannot publish on another agent's behalf, and any " +
          "owner/mesh/agent argument is ignored.",
        inputSchema: {
          path: z.string().describe("file path relative to your $AGENT_MESH_ARTIFACTS directory"),
          caption: z.string().optional().describe("optional caption shown beneath the attachment"),
          name: z.string().optional().describe("optional display name (defaults to the file's basename)"),
        },
      },
      // Only {path, caption, name} are destructured — any impostor field (owner/mesh/agent) a
      // caller tacks on is structurally dropped here and never reaches the handler, which in
      // turn derives the owner solely from this agent's identity (ctx.agentId).
      ({ path, caption, name }) =>
        guarded(agentId, "mesh_publish_attachment", () =>
          opts.handlers.publishAttachment(ctx, path, { caption, name }),
        ),
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
        ({ target, reason }) => guarded(agentId, "interrupt", () => opts.handlers.interrupt(ctx, target, reason)),
      );
    }

    return server;
  }

  // Re-registering (every respawn does) refreshes the steer-target snapshot.
  async function register(agentId: AgentId, role: AgentRole): Promise<void> {
    const steerTargets = await opts.handlers.steerTargets({ agentId, role });
    entries.set(agentId, { role, steerTargets });
  }

  return {
    register,
    urlFor: (agentId) => `http://${host}:${httpServer.port}/${encodeURIComponent(agentId)}/mcp`,
    get port() {
      return httpServer.port!;
    },
    close: () => httpServer.stop(true),
  };
}
