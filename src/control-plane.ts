// ControlPlane: the single global control plane. Sole ACP client (holds one
// AcpAgentConnection per agent), runs the Mesh Services MCP server, owns the
// mailbox + event bus, and arbitrates permission escalations.
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AcpAgentConnection, type PermissionDecision } from "./acp/client";
import { resolveHarness } from "./harness";
import { Mesh } from "./mesh";
import { createMeshServicesServer, type MeshServicesServer, type MeshToolContext } from "./mcp/mesh-services";
import { sendMail, readMailFor } from "./mailbox";
import { now, type AgentId, type MeshConfig, type MeshEvent } from "./acp/types";

interface PendingDecision {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ControlPlaneOptions {
  mailboxPath?: string;
  /** auto-deny a permission request after this many ms with no human decision */
  permissionTimeoutMs?: number;
  debug?: boolean;
}

export class ControlPlane {
  readonly mesh: Mesh;
  private conns = new Map<AgentId, AcpAgentConnection>();
  private listeners = new Set<(e: MeshEvent) => void>();
  private mcp?: MeshServicesServer;
  private mailboxPath: string;
  private mailCursors = new Map<AgentId, string | undefined>();
  private pending = new Map<string, PendingDecision>();
  private permissionTimeoutMs: number;
  private debug: boolean;

  constructor(config: MeshConfig, opts: ControlPlaneOptions = {}) {
    this.mesh = new Mesh(config);
    this.mailboxPath = opts.mailboxPath ?? resolve(process.cwd(), ".mesh", `${config.name}-mailbox.ndjson`);
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? 60_000;
    this.debug = opts.debug ?? false;
  }

  // ---- event bus ----
  on(listener: (e: MeshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(e: MeshEvent): void {
    for (const l of this.listeners) l(e);
  }
  private log(text: string): void {
    this.emit({ kind: "log", text, ts: now() });
  }

  agent(id: AgentId): AcpAgentConnection {
    const c = this.conns.get(id);
    if (!c) throw new Error(`no connection for agent ${id}`);
    return c;
  }

  /** Public: send a prompt turn to an agent (the control plane is the sole driver). */
  prompt(id: AgentId, text: string) {
    return this.agent(id).prompt(text);
  }

  /** Switch an agent's permission/approval mode (delegates to its connection). */
  setMode(id: AgentId, modeId: string): Promise<void> {
    return this.agent(id).setMode(modeId);
  }

  get mcpServer(): MeshServicesServer {
    if (!this.mcp) throw new Error("control plane not started");
    return this.mcp;
  }

  // ---- lifecycle ----
  async start(): Promise<void> {
    await mkdir(resolve(this.mailboxPath, ".."), { recursive: true });

    this.mcp = createMeshServicesServer({
      handlers: {
        meshStatus: (ctx) => this.meshStatusText(ctx.agentId),
        sendMail: (ctx, to, body) => this.handleSendMail(ctx, to, body),
        checkMail: (ctx) => this.handleCheckMail(ctx),
        interrupt: (ctx, target, reason) => this.handleInterrupt(ctx, target, reason),
      },
    });

    for (const a of this.mesh.agents) {
      const spec = resolveHarness(a.harness);
      // codex defaults to slow xhigh reasoning; use low for responsiveness.
      const args = a.harness === "codex" ? [...spec.args, "-c", "model_reasoning_effort=low"] : spec.args;
      const cwd = resolve(process.cwd(), a.project);

      await this.mcp.register(a.id, a.role);
      const conn = new AcpAgentConnection({
        id: a.id,
        command: spec.command,
        args,
        cwd,
        debug: this.debug,
        onUpdate: (u) => this.emit({ kind: "update", agent: a.id, update: u, ts: now() }),
        onPermission: (req) => this.handlePermission(a.id, req),
        onExit: (code) => {
          this.mesh.setStatus(a.id, "dead");
          this.emit({ kind: "agent_status", agent: a.id, status: "dead", detail: `exit ${code}`, ts: now() });
        },
      });
      this.conns.set(a.id, conn);

      this.emit({ kind: "agent_status", agent: a.id, status: "spawning", ts: now() });
      await conn.start();
      await conn.initialize();
      await conn.newSession([{ type: "http", name: "mesh", url: this.mcp.urlFor(a.id), headers: [] }]);
      this.mesh.setStatus(a.id, "ready");
      this.emit({ kind: "agent_status", agent: a.id, status: "ready", ts: now() });
    }
  }

  async stop(): Promise<void> {
    for (const c of this.conns.values()) c.kill();
    this.mcp?.close();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  // ---- mesh tool handlers ----
  private meshStatusText(forAgent: AgentId): string {
    const lines = this.mesh.agents.map((a) => {
      const reach = this.mesh.agents
        .filter((o) => o.id !== a.id && this.mesh.canMail(a.id, o.id))
        .map((o) => o.id);
      const me = a.id === forAgent ? " (you)" : "";
      return `- ${a.id}${me} [${a.harness}, ${a.role}, ${this.mesh.status(a.id)}] can mail: ${reach.join(", ") || "(none)"}`;
    });
    return `Mesh "${this.mesh.name}" — router is ${this.mesh.router.id}.\n${lines.join("\n")}`;
  }

  private async handleSendMail(ctx: MeshToolContext, to: AgentId, body: string): Promise<string> {
    if (!this.mesh.agent(to)) return `error: no such agent "${to}" in this mesh`;
    if (!this.mesh.canMail(ctx.agentId, to)) {
      return `error: you (${ctx.agentId}) are not allowed to mail ${to}`;
    }
    await sendMail({ mailboxPath: this.mailboxPath, mesh: this.mesh.name, from: ctx.agentId, to, body });
    this.emit({ kind: "mail", from: ctx.agentId, to, body, ts: now() });
    // Wake the recipient asynchronously (fire-and-forget; sender's tool returns now).
    this.wake(to, ctx.agentId, body);
    return `delivered to ${to}`;
  }

  private wake(to: AgentId, from: AgentId, body: string): void {
    const conn = this.conns.get(to);
    if (!conn) return;
    conn
      .prompt(
        `[MAIL from ${from}]: ${body}\n\n` +
          `This arrived in your mesh mailbox. Read it and respond appropriately; ` +
          `you may reply with the send_mail tool (to: "${from}").`,
      )
      .catch((err) => this.log(`wake(${to}) failed: ${String(err)}`));
  }

  private async handleCheckMail(ctx: MeshToolContext): Promise<string> {
    const cursor = this.mailCursors.get(ctx.agentId);
    const mail = await readMailFor(ctx.agentId, { mailboxPath: this.mailboxPath, sinceId: cursor });
    if (mail.length === 0) return "no new mail";
    this.mailCursors.set(ctx.agentId, mail[mail.length - 1]!.id);
    return mail.map((m) => `from ${(m.meta as any)?.from ?? m.from}: ${m.body}`).join("\n");
  }

  private async handleInterrupt(ctx: MeshToolContext, target: AgentId, reason?: string): Promise<string> {
    if (ctx.role !== "router") return `error: only the router may interrupt`;
    if (!this.conns.has(target)) return `error: no such agent "${target}"`;
    this.emit({ kind: "interrupt", from: ctx.agentId, target, reason, ts: now() });
    await this.agent(target).cancel();
    return `interrupted ${target}`;
  }

  // ---- permission escalation ----
  private static readonly MESH_TOOLS = new Set(["send_mail", "check_mail", "interrupt", "mesh_status"]);

  /**
   * Is this permission request for one of OUR injected mesh tools? Match the
   * canonical tool identifier exactly (bare name, or the `mcp__mesh__<tool>`
   * namespaced form emitted by MCP clients for our server, which we named
   * "mesh"). We deliberately do NOT substring-match or trust agent-supplied
   * free-text (e.g. rawInput.name / a file path), so a member's real op that
   * merely contains "interrupt" still escalates to a human.
   */
  private isMeshTool(toolName: string): boolean {
    if (ControlPlane.MESH_TOOLS.has(toolName)) return true;
    const m = toolName.match(/^mcp__mesh__(.+)$/);
    return m ? ControlPlane.MESH_TOOLS.has(m[1]!) : false;
  }

  private handlePermission(agentId: AgentId, req: any): Promise<PermissionDecision> {
    // Internal mesh-coordination tools are pre-authorized by mesh membership;
    // only external/dangerous operations escalate to a human.
    const toolName = String(req.toolCall?.toolName ?? req.toolCall?.title ?? "");
    if (this.isMeshTool(toolName)) {
      const allow = (req.options ?? []).find((o: any) => o.kind === "allow_once") ?? (req.options ?? [])[0];
      this.log(`auto-approved mesh tool: ${toolName || "(unknown)"} for ${agentId}`);
      return Promise.resolve(allow ? { optionId: allow.optionId } : "cancel");
    }

    const requestId = randomUUID();
    const options = (req.options ?? []).map((o: any) => ({
      id: o.optionId,
      name: o.name,
      kind: o.kind,
    }));
    const question = req.toolCall?.title ?? req.toolCall?.rawInput?.command ?? "permission requested";

    this.emit({ kind: "permission", agent: agentId, requestId, question: String(question), options, ts: now() });

    return new Promise<PermissionDecision>((resolveDecision) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const reject = (req.options ?? []).find((o: any) => o.kind?.startsWith("reject"));
        const decision: PermissionDecision = reject ? { optionId: reject.optionId } : "cancel";
        this.emit({
          kind: "permission_resolved",
          agent: agentId,
          requestId,
          optionId: reject?.optionId ?? "cancel",
          by: "timeout",
          ts: now(),
        });
        resolveDecision(decision);
      }, this.permissionTimeoutMs);
      this.pending.set(requestId, { resolve: resolveDecision, timer });
    });
  }

  /** Resolve a pending permission request (called by the TUI/human or e2e). */
  resolveDecision(requestId: string, optionId: string, by: "human" | "timeout" = "human"): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    this.emit({ kind: "permission_resolved", agent: "?", requestId, optionId, by, ts: now() });
    p.resolve({ optionId });
    return true;
  }

  pendingDecisions(): { requestId: string }[] {
    return [...this.pending.keys()].map((requestId) => ({ requestId }));
  }
}
