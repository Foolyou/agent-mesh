// Mesh Services: a single HTTP MCP server injected into every agent session.
// Each agent connects at /{agentId}/mcp; the agent's identity is the path
// segment, so tool callbacks know who is calling. Tools delegate to the
// control-plane handlers passed in.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AgentId, AgentRole } from "../acp/types";
import type { BoardCommand, BoardStatus, BoardPriority, LifecycleKind } from "../board";

export interface MeshToolContext {
  agentId: AgentId;
  role: AgentRole;
}

export interface SendMailOptions {
  replyTo?: number;
  task?: string;
  /** Structured lifecycle signal for the mail-marker path (§5.1): when `task` resolves to a board
   *  issue, an assignee-signalable kind (branch_created/accepted/review_requested) moves the card.
   *  The control-plane reducer enforces permission; a non-assignee signal is a silent no-op. */
  lifecycle?: LifecycleKind;
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
  /** Render the full board for the caller (read-only). */
  boardList(ctx: MeshToolContext): Promise<string> | string;
  /** Apply a board mutation. The control-plane derives the actor from ctx.role (auth recheck)
   *  and runs it through the board reducer; `expectedBoardRevision` is the board-level CAS. */
  applyBoard(ctx: MeshToolContext, command: BoardCommand, expectedBoardRevision: number): Promise<string> | string;
  /** Router-only atomic dispatch funnel: assign + linkage + `dispatched`→in_progress, then mail the
   *  brief to the assignee and backfill the mail outcome. One deliberate call hands a task off. */
  dispatchBoard(
    ctx: MeshToolContext,
    args: { taskId: number; assignee: string; slug: string; branchName?: string; brief?: string; expectedRevision: number; expectedBoardRevision: number },
  ): Promise<string> | string;
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

type GuardedRun = (agentId: string, tool: string, run: () => Promise<string> | string) => Promise<{ content: { type: "text"; text: string }[] }>;

const BOARD_STATUS = z.enum(["todo", "in_progress", "in_review", "done", "cancelled"]);
const BOARD_PRIORITY = z.enum(["low", "normal", "high", "urgent"]);
// Lifecycle kinds an assignee may signal over send_mail (privileged kinds go through board_dispatch
// / the integration path, never a mail field).
const BOARD_MAIL_LIFECYCLE = z.enum(["branch_created", "accepted", "review_requested"]);
// Full lifecycle vocabulary the board_lifecycle tool accepts; the reducer gates privileged kinds.
const BOARD_LIFECYCLE_KIND = z.enum(["dispatched", "branch_created", "accepted", "review_requested", "integration_ready", "reopened"]);
// CAS tokens. Two distinct levels: STRUCTURAL changes (create/delete an epic or task) gate on the
// whole-board revision; every other ENTITY edit (status/assign/comment/lifecycle/dispatch/…) gates
// ONLY on that entity's own revision, so concurrent edits to different tasks never false-conflict.
const EBR = "the board revision you last saw (from board_list). Only STRUCTURAL changes (create/delete) are rejected if the board changed since; entity edits are gated by the entity revision, not this.";
const ER = "the target entity's revision you last saw (from board_list); the write is rejected if that entity changed since (entity-level CAS).";

/** Register the collaboration-board MCP tools. Read + task/subtask/comment tools are open to
 *  every member; epic CRUD and assign/priority/deps are router-only (NOT registered for
 *  members, AND re-checked server-side by the reducer via the actor derived from ctx.role).
 *  Each mutating tool carries CAS tokens: expectedBoardRevision (board-level) and, for
 *  existing entities, expectedRevision (entity-level). */
function registerBoardTools(
  server: McpServer,
  agentId: AgentId,
  role: AgentRole,
  ctx: MeshToolContext,
  guarded: GuardedRun,
  handlers: MeshServicesHandlers,
): void {
  const status = (s: BoardStatus) => s; // identity, keeps the enum value typed as BoardStatus
  const priority = (p: BoardPriority) => p;

  server.registerTool(
    "board_list",
    { description: "Show the mesh's collaboration board (epics, tasks #N, subtasks, statuses, assignees, deps, comments) plus the board revision you must echo on writes and your own open tasks." },
    () => guarded(agentId, "board_list", () => handlers.boardList(ctx)),
  );

  server.registerTool(
    "board_create_subtask",
    {
      description: "Add a subtask to task #N.",
      inputSchema: {
        taskId: z.number().int().positive(),
        title: z.string(),
        assignee: z.string().optional().describe("agent id (router only)"),
        expectedRevision: z.number().int().describe(`${ER} (the parent task's)`),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ taskId, title, assignee, expectedRevision, expectedBoardRevision }) =>
      guarded(agentId, "board_create_subtask", () =>
        handlers.applyBoard(ctx, { type: "create_subtask", taskId, title, assignee, expectedRevision }, expectedBoardRevision),
      ),
  );

  server.registerTool(
    "board_set_status",
    {
      description: "Set the status of a task (or a subtask, if subtaskId is given). You may only change items assigned to you (or that you created and nobody else owns), and only up to 'in_review' — 'done'/'cancelled' are router-only.",
      inputSchema: {
        taskId: z.number().int().positive(),
        subtaskId: z.string().optional().describe('e.g. "5.1" to target a subtask instead of the task'),
        status: BOARD_STATUS,
        expectedRevision: z.number().int().describe(ER),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ taskId, subtaskId, status: st, expectedRevision, expectedBoardRevision }) => {
      const command: BoardCommand = subtaskId
        ? { type: "set_subtask_status", taskId, subtaskId, expectedRevision, status: status(st) }
        : { type: "set_task_status", id: taskId, expectedRevision, status: status(st) };
      return guarded(agentId, "board_set_status", () => handlers.applyBoard(ctx, command, expectedBoardRevision));
    },
  );

  server.registerTool(
    "board_comment",
    {
      description: "Append a comment to an epic, task, or subtask. Provide epicId, OR taskId (optionally with subtaskId).",
      inputSchema: {
        epicId: z.string().optional(),
        taskId: z.number().int().positive().optional(),
        subtaskId: z.string().optional(),
        text: z.string(),
        expectedRevision: z.number().int().describe(`${ER} (of the commented entity)`),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ epicId, taskId, subtaskId, text, expectedRevision, expectedBoardRevision }) => {
      const target = epicId
        ? ({ kind: "epic", id: epicId } as const)
        : subtaskId && taskId !== undefined
          ? ({ kind: "subtask", taskId, subtaskId } as const)
          : ({ kind: "task", id: taskId ?? -1 } as const);
      return guarded(agentId, "board_comment", () =>
        handlers.applyBoard(ctx, { type: "add_comment", target, expectedRevision, text }, expectedBoardRevision),
      );
    },
  );

  // board_lifecycle is available to ALL roles; the reducer enforces permission — an assignee may
  // signal branch_created/accepted (→ in_progress) and review_requested (→ in_review), while
  // dispatched/integration_ready/reopened are router/operator-only. A non-assignee member is rejected.
  server.registerTool(
    "board_lifecycle",
    {
      description:
        "Signal a task lifecycle event so its status auto-reflows. As the task's assignee you may emit " +
        "'branch_created'/'accepted' (→ in_progress) or 'review_requested' (→ in_review). " +
        "'dispatched'/'integration_ready'/'reopened' are router/operator-only. Status only moves forward " +
        "(never regresses, never to done/cancelled — those need an explicit close).",
      inputSchema: {
        taskId: z.number().int().positive(),
        kind: BOARD_LIFECYCLE_KIND,
        threadKey: z.string().optional().describe("idempotency/thread key (defaults to the task slug); re-emitting the same (task, kind, threadKey) is a no-op"),
        expectedRevision: z.number().int().describe(`${ER} (of the task)`),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ taskId, kind, threadKey, expectedRevision, expectedBoardRevision }) =>
      guarded(agentId, "board_lifecycle", () =>
        handlers.applyBoard(ctx, { type: "record_lifecycle_event", taskId, expectedRevision, kind, threadKey }, expectedBoardRevision),
      ),
  );

  // Available to all roles; the reducer gates to the task's assignee or a privileged actor.
  server.registerTool(
    "board_set_task_labels",
    {
      description:
        "Replace the full set of labels on a task. Allowed for the task's assignee or a router/operator; " +
        "unknown label ids are dropped and order is preserved. Use board_list to see available label ids.",
      inputSchema: {
        taskId: z.number().int().positive(),
        labelIds: z.array(z.string()).describe("label ids (from board_list) to set; REPLACES the current set"),
        expectedRevision: z.number().int().describe(`${ER} (of the task)`),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ taskId, labelIds, expectedRevision, expectedBoardRevision }) =>
      guarded(agentId, "board_set_task_labels", () =>
        handlers.applyBoard(ctx, { type: "set_task_labels", id: taskId, expectedRevision, labelIds }, expectedBoardRevision),
      ),
  );

  if (role !== "router") return;

  server.registerTool(
    "board_dispatch",
    {
      description:
        "Dispatch a task to an assignee in ONE deliberate action (router/operator only): assigns the task, " +
        "records its slug + branch (task/<slug>) + dispatch, mails the assignee the brief, and moves the card " +
        "to in_progress. Use board_assign for a bare re-assign without a hand-off. If the mail fails the " +
        "assignment + in_progress still stand and dispatch.mailFailed is surfaced.",
      inputSchema: {
        taskId: z.number().int().positive(),
        assignee: z.string().describe("agent id to hand the task to"),
        slug: z.string().describe("task slug; the branch is task/<slug>"),
        branchName: z.string().optional().describe("override branch name (defaults to task/<slug>)"),
        brief: z.string().optional().describe("instructions mailed to the assignee with the task ref"),
        expectedRevision: z.number().int().describe(`${ER} (of the task)`),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ taskId, assignee, slug, branchName, brief, expectedRevision, expectedBoardRevision }) =>
      guarded(agentId, "board_dispatch", () =>
        handlers.dispatchBoard(ctx, { taskId, assignee, slug, branchName, brief, expectedRevision, expectedBoardRevision }),
      ),
  );

  // ── labels (router/operator only) ──
  server.registerTool(
    "board_create_label",
    {
      description: "Create a board label (router/operator only). color must be one of the accessible palette colors (see board_list / the panel swatches).",
      inputSchema: {
        name: z.string().describe("label name"),
        color: z.string().describe("accessible palette hex, e.g. #fde68a"),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ name, color, expectedBoardRevision }) =>
      guarded(agentId, "board_create_label", () => handlers.applyBoard(ctx, { type: "create_label", name, color }, expectedBoardRevision)),
  );

  server.registerTool(
    "board_update_label",
    {
      description: "Rename and/or recolor a label (router/operator only). color must be a palette color.",
      inputSchema: {
        id: z.string().describe("label id like label-1"),
        name: z.string().optional(),
        color: z.string().optional().describe("accessible palette hex"),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ id, name, color, expectedBoardRevision }) =>
      guarded(agentId, "board_update_label", () => handlers.applyBoard(ctx, { type: "update_label", id, name, color }, expectedBoardRevision)),
  );

  server.registerTool(
    "board_delete_label",
    {
      description: "Delete a label (router/operator only). Its id is removed from every task that carried it.",
      inputSchema: {
        id: z.string().describe("label id like label-1"),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ id, expectedBoardRevision }) =>
      guarded(agentId, "board_delete_label", () => handlers.applyBoard(ctx, { type: "delete_label", id }, expectedBoardRevision)),
  );

  server.registerTool(
    "board_create_task",
    {
      description: "Create a board task (#N). Router/operator only — members work the tasks dispatched to them. May file under an epic, assign, set deps, and set any priority.",
      inputSchema: {
        title: z.string().describe("short task title"),
        description: z.string().optional(),
        epicId: z.string().optional().describe('parent epic id like "epic-2"'),
        priority: BOARD_PRIORITY.optional(),
        deps: z.array(z.number().int().positive()).optional().describe("task ids this depends on"),
        assignee: z.string().optional().describe("agent id"),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ title, description, epicId, priority: pr, deps, assignee, expectedBoardRevision }) =>
      guarded(agentId, "board_create_task", () =>
        handlers.applyBoard(ctx, { type: "create_task", title, description, epicId, priority: pr ? priority(pr) : undefined, deps, assignee }, expectedBoardRevision),
      ),
  );

  server.registerTool(
    "board_create_epic",
    {
      description: "Create an epic (router only). Displayed as E{N}.",
      inputSchema: { title: z.string(), description: z.string().optional(), expectedBoardRevision: z.number().int().describe(EBR) },
    },
    ({ title, description, expectedBoardRevision }) =>
      guarded(agentId, "board_create_epic", () => handlers.applyBoard(ctx, { type: "create_epic", title, description }, expectedBoardRevision)),
  );

  server.registerTool(
    "board_update_epic",
    {
      description: "Update an epic's title/description/status (router only).",
      inputSchema: {
        id: z.string().describe('epic id like "epic-2"'),
        title: z.string().optional(),
        description: z.string().optional(),
        status: BOARD_STATUS.optional(),
        expectedRevision: z.number().int().describe(ER),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ id, title, description, status: st, expectedRevision, expectedBoardRevision }) =>
      guarded(agentId, "board_update_epic", () =>
        handlers.applyBoard(ctx, { type: "update_epic", id, title, description, status: st ? status(st) : undefined, expectedRevision }, expectedBoardRevision),
      ),
  );

  server.registerTool(
    "board_delete_epic",
    {
      description: "Delete an epic (router only). Its tasks are orphaned (epic cleared), not deleted.",
      inputSchema: { id: z.string(), expectedRevision: z.number().int().describe(ER), expectedBoardRevision: z.number().int().describe(EBR) },
    },
    ({ id, expectedRevision, expectedBoardRevision }) =>
      guarded(agentId, "board_delete_epic", () => handlers.applyBoard(ctx, { type: "delete_epic", id, expectedRevision }, expectedBoardRevision)),
  );

  server.registerTool(
    "board_assign",
    {
      description: "Assign (or unassign) a task to an agent (router only).",
      inputSchema: {
        taskId: z.number().int().positive(),
        assignee: z.string().optional().describe("agent id; omit to unassign"),
        expectedRevision: z.number().int().describe(ER),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ taskId, assignee, expectedRevision, expectedBoardRevision }) =>
      guarded(agentId, "board_assign", () => handlers.applyBoard(ctx, { type: "assign_task", id: taskId, assignee, expectedRevision }, expectedBoardRevision)),
  );

  server.registerTool(
    "board_set_priority",
    {
      description: "Set a task's priority (router only).",
      inputSchema: {
        taskId: z.number().int().positive(),
        priority: BOARD_PRIORITY,
        expectedRevision: z.number().int().describe(ER),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ taskId, priority: pr, expectedRevision, expectedBoardRevision }) =>
      guarded(agentId, "board_set_priority", () => handlers.applyBoard(ctx, { type: "set_task_priority", id: taskId, priority: priority(pr), expectedRevision }, expectedBoardRevision)),
  );

  server.registerTool(
    "board_set_deps",
    {
      description: "Set a task's dependency task ids (router only). Cycles/dangling refs surface as advisory warnings, never hard blocks.",
      inputSchema: {
        taskId: z.number().int().positive(),
        deps: z.array(z.number().int().positive()),
        expectedRevision: z.number().int().describe(ER),
        expectedBoardRevision: z.number().int().describe(EBR),
      },
    },
    ({ taskId, deps, expectedRevision, expectedBoardRevision }) =>
      guarded(agentId, "board_set_deps", () => handlers.applyBoard(ctx, { type: "set_task_deps", id: taskId, deps, expectedRevision }, expectedBoardRevision)),
  );
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
          task: z.string().optional().describe("board task ref this mail belongs to: '#N' (id) or a task slug. Links the mail to the issue and routes a lifecycle signal."),
          lifecycle: BOARD_MAIL_LIFECYCLE.optional().describe(
            "lifecycle signal for the linked task (requires `task`): 'branch_created'/'accepted' → in_progress, 'review_requested' → in_review. Only the task's assignee may move its card; ignored otherwise.",
          ),
        },
      },
      ({ to, body, reply_to, task, lifecycle }) =>
        guarded(agentId, "send_mail", () => opts.handlers.sendMail(ctx, to, body, { replyTo: reply_to, task, lifecycle })),
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

    registerBoardTools(server, agentId, role, ctx, guarded, opts.handlers);

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
