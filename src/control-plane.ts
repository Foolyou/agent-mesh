// ControlPlane: the single global control plane. Sole ACP client (holds one
// AcpAgentConnection per agent), runs the Mesh Services MCP server, owns the
// mailbox + event bus, and arbitrates permission escalations.
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AcpAgentConnection, type AcpConnectionOptions, type PermissionDecision } from "./acp/client";
import { spawnConfigFor } from "./harness";
import { Mesh } from "./mesh";
import { buildMeshBriefing } from "./mesh-briefing";
import { createMeshServicesServer, type MeshServicesServer, type MeshToolContext } from "./mcp/mesh-services";
import { sendMail, readMailFor } from "./mailbox";
import { now, type AgentActivity, type AgentId, type MeshConfig, type MeshEvent, type PromptImageRef, type SessionMode, type SessionModel } from "./acp/types";

interface PendingDecision {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ControlPlaneOptions {
  mailboxPath?: string;
  /** auto-deny a permission request after this many ms with no human decision */
  permissionTimeoutMs?: number;
  debug?: boolean;
  uploadRoot?: string;
  connectionFactory?: (opts: AcpConnectionOptions) => AcpAgentConnection;
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
  private uploadRoot?: string;
  private connectionFactory: (opts: AcpConnectionOptions) => AcpAgentConnection;
  /** Per-agent advertised image-input capability (promptCapabilities.image). */
  private imageCaps = new Map<AgentId, boolean>();
  /** Per-agent advertised permission/session modes. */
  private sessionModes = new Map<AgentId, { current: string; available: SessionMode[] }>();
  /** Per-agent advertised model choices. */
  private sessionModels = new Map<AgentId, { current: string; available: SessionModel[] }>();
  /** Agents that have already received the one-time mesh briefing. */
  private briefed = new Set<AgentId>();
  /** Per-agent in-flight prompt turns. count > 0 means working unless the agent is dead. */
  private turnCounts = new Map<AgentId, number>();
  private activityStates = new Map<AgentId, AgentActivity>();

  constructor(config: MeshConfig, opts: ControlPlaneOptions = {}) {
    this.mesh = new Mesh(config);
    this.mailboxPath = opts.mailboxPath ?? resolve(process.cwd(), ".mesh", `${config.name}-mailbox.ndjson`);
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? 60_000;
    this.debug = opts.debug ?? false;
    this.uploadRoot = opts.uploadRoot;
    this.connectionFactory = opts.connectionFactory ?? ((connOpts) => new AcpAgentConnection(connOpts));
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

  /** Current authoritative agent state for reconnecting clients. */
  snapshotEvents(): MeshEvent[] {
    const ts = now();
    const events: MeshEvent[] = [];
    for (const a of this.mesh.agents) {
      events.push({ kind: "agent_status", agent: a.id, status: this.mesh.status(a.id) ?? "spawning", ts });
      events.push({ kind: "agent_activity", agent: a.id, activity: this.activityOf(a.id), ts });
      if (this.imageCaps.has(a.id)) {
        events.push({ kind: "agent_capabilities", agent: a.id, image: this.imageCaps.get(a.id)!, ts });
      }
      const modes = this.sessionModes.get(a.id);
      if (modes) {
        events.push({ kind: "agent_modes", agent: a.id, current: modes.current, available: modes.available, ts });
      }
      const models = this.sessionModels.get(a.id);
      if (models) {
        events.push({ kind: "agent_models", agent: a.id, current: models.current, available: models.available, ts });
      }
    }
    return events;
  }

  /** Prepend the one-time mesh briefing to an agent's very first prompt, so it knows
   *  it is part of a collaborating mesh before it does any work. */
  private compose(id: AgentId, text: string): string {
    if (this.briefed.has(id)) return text;
    this.briefed.add(id);
    const briefing = buildMeshBriefing(this.mesh, id);
    if (!briefing) return text;
    return `${briefing}\n\n---\n\nYour first task / message follows:\n\n${text}`;
  }

  /** Public: send a prompt turn to an agent (the control plane is the sole driver). Image
   *  blocks are dropped for agents that did not advertise image input, so a non-image agent
   *  still gets the text turn instead of rejecting the whole prompt. */
  prompt(id: AgentId, text: string, images: PromptImageRef[] = []) {
    const imgs = this.imageCaps.get(id) ? images : [];
    const conn = this.agent(id);
    const prompt = this.compose(id, text);
    const promptImages = imgs.map((i) => this.resolveImagePath(i));
    return this.trackTurn(
      id,
      () => conn.prompt(prompt, promptImages),
    );
  }

  /** Switch an agent's permission/approval mode (delegates to its connection). */
  async setMode(id: AgentId, modeId: string): Promise<void> {
    await this.agent(id).setMode(modeId);
    const modes = this.sessionModes.get(id);
    if (modes) this.sessionModes.set(id, { ...modes, current: modeId });
    // Some agents (e.g. claude) don't emit a current_mode_update after setSessionMode, so the
    // operator's picker would snap back to the old mode. Echo the change ourselves so the UI
    // reflects the switch immediately (the gateway folds current_mode_update into pm.modes).
    this.emit({ kind: "update", agent: id, update: { sessionUpdate: "current_mode_update", currentModeId: modeId }, ts: now() });
  }

  /** Switch an agent's model (delegates to its connection, then echoes state for the UI). */
  async setModel(id: AgentId, modelId: string): Promise<void> {
    await this.agent(id).setModel(modelId);
    const models = this.sessionModels.get(id);
    if (models) {
      const next = { ...models, current: modelId };
      this.sessionModels.set(id, next);
      this.emit({ kind: "agent_models", agent: id, current: next.current, available: next.available, ts: now() });
    }
  }

  /** Operator-initiated interrupt: cancel an agent's current turn and record it.
   *  (The router can also interrupt via its mesh tool; this is the human path.) */
  async interrupt(id: AgentId, by: AgentId = "operator"): Promise<void> {
    this.emit({ kind: "interrupt", from: by, target: id, reason: "operator interrupt", ts: now() });
    await this.agent(id).cancel();
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
        steerMail: (ctx, to, body) => this.handleSteerMail(ctx, to, body),
        steerTargets: (ctx) => this.steerTargets(ctx.agentId),
        checkMail: (ctx) => this.handleCheckMail(ctx),
        interrupt: (ctx, target, reason) => this.handleInterrupt(ctx, target, reason),
      },
    });

    for (const a of this.mesh.agents) {
      // Per-agent spawn config applies the chosen thinking effort (codex flag / claude env);
      // codex defaults to "low" for responsiveness when no effort is set.
      const { command, args, env } = spawnConfigFor(a);
      const cwd = resolve(process.cwd(), a.project);

      await this.mcp.register(a.id, a.role);
      const conn = this.connectionFactory({
        id: a.id,
        command,
        args,
        cwd,
        extraEnv: env,
        debug: this.debug,
        onUpdate: (u) => this.emit({ kind: "update", agent: a.id, update: u, ts: now() }),
        onPermission: (req) => this.handlePermission(a.id, req),
        onExit: (code) => {
          this.mesh.setStatus(a.id, "dead");
          this.turnCounts.set(a.id, 0);
          this.emitActivityIfChanged(a.id);
          this.emit({ kind: "agent_status", agent: a.id, status: "dead", detail: `exit ${code}`, ts: now() });
        },
      });
      this.conns.set(a.id, conn);

      this.emit({ kind: "agent_status", agent: a.id, status: "spawning", ts: now() });
      await conn.start();
      const initRes = await conn.initialize();
      const session = await conn.newSession([{ type: "http", name: "mesh", url: this.mcp.urlFor(a.id), headers: [] }]);
      // Surface the agent's advertised session modes so the operator gets a real picker
      // (read-only / full-access / plan / …) instead of having to know mode-id strings.
      const standardModes = (session as any)?.modes;
      const configMode = deriveConfigOption(session, "mode");
      const available = ((standardModes?.availableModes ?? []).length
        ? (standardModes.availableModes ?? []).map((mo: any) => ({ id: mo.id, name: mo.name ?? mo.id, description: mo.description ?? undefined }))
        : (configMode?.available ?? [])) as SessionMode[];
      // Apply a configured initial permission/session mode (best-effort) before the first turn.
      let current: string = standardModes?.currentModeId ?? configMode?.current ?? available[0]?.id ?? "";
      if (a.mode && available.some((mo: any) => mo.id === a.mode)) {
        try {
          await conn.setMode(a.mode);
          current = a.mode;
        } catch (err) {
          this.log(`set cached mode ${a.id}=${a.mode} failed: ${String(err)}`);
        }
      } else if (a.mode && available.length) {
        this.log(`skip cached mode ${a.id}=${a.mode}: not advertised`);
      }
      if (available.length) {
        this.sessionModes.set(a.id, { current, available });
        this.emit({ kind: "agent_modes", agent: a.id, current, available, ts: now() });
      }
      const configModel = deriveConfigOption(session, "model");
      if (configModel?.available.length) {
        let currentModel = configModel.current;
        if (a.model && configModel.available.some((mo) => mo.id === a.model)) {
          try {
            await conn.setModel(a.model);
            currentModel = a.model;
          } catch (err) {
            this.log(`set cached model ${a.id}=${a.model} failed: ${String(err)}`);
          }
        } else if (a.model) {
          this.log(`skip cached model ${a.id}=${a.model}: not advertised`);
        }
        this.sessionModels.set(a.id, { current: currentModel, available: configModel.available });
        this.emit({ kind: "agent_models", agent: a.id, current: currentModel, available: configModel.available, ts: now() });
      }
      const imageCap = !!(initRes as any)?.agentCapabilities?.promptCapabilities?.image;
      this.imageCaps.set(a.id, imageCap);
      this.emit({ kind: "agent_capabilities", agent: a.id, image: imageCap, ts: now() });
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
      return `- ${a.id}${me} [${a.harness}, ${a.role}, ${this.mesh.status(a.id)}, ${this.activityOf(a.id)}] can mail: ${reach.join(", ") || "(none)"}`;
    });
    return `Mesh "${this.mesh.name}" — router is ${this.mesh.router.id}.\n${lines.join("\n")}`;
  }

  private steerTargets(from: AgentId): AgentId[] {
    return this.mesh.agents.filter((agent) => agent.id !== from && this.mesh.canSteer(from, agent.id)).map((agent) => agent.id);
  }

  private activityOf(id: AgentId): AgentActivity {
    if (this.mesh.status(id) === "dead") return "idle";
    return (this.turnCounts.get(id) ?? 0) > 0 ? "working" : "idle";
  }

  private emitActivityIfChanged(id: AgentId): void {
    const activity = this.activityOf(id);
    if ((this.activityStates.get(id) ?? "idle") === activity) return;
    this.activityStates.set(id, activity);
    this.emit({ kind: "agent_activity", agent: id, activity, ts: now() });
  }

  private trackTurn<T>(id: AgentId, start: () => Promise<T>): Promise<T> {
    this.turnCounts.set(id, (this.turnCounts.get(id) ?? 0) + 1);
    this.emitActivityIfChanged(id);
    let turn: Promise<T>;
    try {
      turn = start();
    } catch (err) {
      this.finishTurn(id);
      throw err;
    }
    return turn.finally(() => this.finishTurn(id));
  }

  private finishTurn(id: AgentId): void {
      const next = Math.max(0, (this.turnCounts.get(id) ?? 0) - 1);
      if (next === 0) this.turnCounts.delete(id);
      else this.turnCounts.set(id, next);
      this.emitActivityIfChanged(id);
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
    const mail =
      `[MAIL from ${from}]: ${body}\n\n` +
      `This arrived in your mesh mailbox. Read it and respond appropriately; ` +
      `you may reply with the send_mail tool (to: "${from}").`;
    const prompt = this.compose(to, mail);
    this.trackTurn(to, () => conn.prompt(prompt)).catch((err) => this.log(`wake(${to}) failed: ${String(err)}`));
  }

  private async handleSteerMail(ctx: MeshToolContext, to: AgentId, body: string): Promise<string> {
    if (!this.mesh.agent(to)) return `error: no such agent "${to}" in this mesh; use send_mail for ordinary delivery`;
    if (to === ctx.agentId) return `error: cannot steer yourself; use send_mail for ordinary delivery`;
    if (!this.mesh.canMail(ctx.agentId, to)) {
      return `error: you (${ctx.agentId}) are not allowed to mail ${to}; use send_mail only for permitted ordinary delivery`;
    }
    if (!this.mesh.canSteer(ctx.agentId, to)) {
      const detail = to === this.mesh.router.id ? `cannot steer the router ${to}` : `steer is not enabled from ${ctx.agentId} to ${to}`;
      return `error: ${detail}; use send_mail for ordinary queued delivery`;
    }
    await sendMail({ mailboxPath: this.mailboxPath, mesh: this.mesh.name, from: ctx.agentId, to, body });
    this.emit({ kind: "steer", from: ctx.agentId, to, body, ts: now() });
    this.steerWake(to, ctx.agentId, body);
    return `steered to ${to}`;
  }

  private steerWake(to: AgentId, from: AgentId | "operator", body: string, images: PromptImageRef[] = []): void {
    const conn = this.conns.get(to);
    if (!conn) return;
    const mail =
      `[STEER from ${from}]: ${body}\n\n` +
      `This interrupted your current turn and was placed ahead of ordinary queued mail. ` +
      `Read it and adjust course appropriately.`;
    const prompt = this.compose(to, mail);
    const promptImages = images.map((i) => this.resolveImagePath(i));
    this.trackTurn(to, () => conn.steerPrompt(prompt, promptImages)).catch((err) => this.log(`steerWake(${to}) failed: ${String(err)}`));
  }

  private resolveImagePath(image: PromptImageRef): PromptImageRef {
    if (image.path || !this.uploadRoot || !image.bucket) return image;
    return { ...image, path: join(this.uploadRoot, image.bucket, image.id) };
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
  private static readonly MESH_TOOLS = new Set(["send_mail", "steer_mail", "check_mail", "interrupt", "mesh_status"]);

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

function deriveConfigOption(session: unknown, category: "mode" | "model"): { current: string; available: Array<{ id: string; name: string; description?: string }> } | undefined {
  const options = (session as any)?.configOptions;
  if (!Array.isArray(options)) return undefined;
  const configOption = options.find((o: any) => o?.category === category);
  if (!configOption) return undefined;
  const available = Array.isArray(configOption.options)
    ? configOption.options
        .map((o: any) => {
          const id = String(o?.value ?? "");
          if (!id) return undefined;
          const item: { id: string; name: string; description?: string } = { id, name: String(o?.name ?? o?.value ?? id) };
          if (o?.description !== undefined) item.description = String(o.description);
          return item;
        })
        .filter(Boolean)
    : [];
  const current = String(configOption.currentValue ?? available[0]?.id ?? "");
  return { current, available: available as Array<{ id: string; name: string; description?: string }> };
}
