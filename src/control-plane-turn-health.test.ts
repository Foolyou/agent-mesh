import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { AgentTurn, MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { readMailFor } from "./mailbox";

const config: MeshConfig = {
  name: "turn-health",
  agents: [
    { id: "router", harness: "claude", project: ".", role: "router" },
    { id: "member", harness: "codex", project: ".", role: "member" },
  ],
  edges: [
    { from: "router", to: "member" },
    { from: "member", to: "router" },
  ],
};

type Job = {
  text: string;
  turn?: AgentTurn;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

class HealthConnection {
  prompts: string[] = [];
  queue: Job[] = [];
  active?: Job;
  cancels = 0;
  kills = 0;
  killed = false;

  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `s-${this.opts.id}` };
  }
  prompt(text: string, _images?: unknown, turn?: AgentTurn): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const job: Job = { text, turn, resolve, reject };
      this.prompts.push(text);
      if (turn) this.opts.onPromptQueued?.(turn);
      if (!this.active) this.startJob(job);
      else this.queue.push(job);
    });
  }
  steerPrompt(text: string, images?: unknown, turn?: AgentTurn): Promise<unknown> {
    return this.prompt(text, images, turn);
  }
  removeQueued(predicate: (turn: AgentTurn) => boolean): AgentTurn[] {
    const removed: AgentTurn[] = [];
    this.queue = this.queue.filter((job) => {
      if (!job.turn || !predicate(job.turn)) return true;
      removed.push(job.turn);
      job.resolve({ stopReason: "superseded" });
      return false;
    });
    return removed;
  }
  emitUpdate(update: unknown = { sessionUpdate: "agent_message_chunk", content: { text: "hi" } }): void {
    this.opts.onPromptSignal?.(this.active?.turn, update);
    this.opts.onUpdate?.(update);
  }
  emitExt(method: string, params: unknown): void {
    this.opts.onExtNotification?.(method, params, this.active?.turn);
  }
  finish(value: unknown = { stopReason: "end_turn" }): void {
    const job = this.active;
    this.active = undefined;
    job?.resolve(value);
    const next = this.queue.shift();
    if (next) this.startJob(next);
  }
  failActiveTurn(turnId: string, err: unknown): boolean {
    if (this.active?.turn?.id !== turnId) return false;
    const job = this.active;
    this.active = undefined;
    job.reject(err);
    const next = this.queue.shift();
    if (next) this.startJob(next);
    return true;
  }
  private startJob(job: Job): void {
    this.active = job;
    if (job.turn) this.opts.onPromptStarted?.(job.turn);
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {
    this.cancels++;
  }
  kill(): void {
    this.killed = true;
    this.kills++;
  }
}

function waitUntil(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function makePlane(root: string, created: Record<string, HealthConnection>) {
  return new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 10,
    connectionFactory: (opts) => {
      const conn = new HealthConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });
}

const warnings = (events: any[]) => events.filter((e) => e.kind === "agent_turn_health" && e.level === "warning");

test("a quiet started prompt surfaces a warning but never cancels or kills the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-quiet-"));
  const created: Record<string, HealthConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    const prompt = cp.prompt("member", "long silent reasoning");

    await waitUntil(() => warnings(events).length > 0);

    // The watchdog only warned — the turn and its process are untouched.
    expect(created.member.cancels).toBe(0);
    expect(created.member.kills).toBe(0);
    expect(created.member.killed).toBe(false);
    expect((cp as any).mesh.status("member")).toBe("ready");
    expect(created.member.active).toBeTruthy(); // turn still in flight
    expect(warnings(events)[0]).toMatchObject({ agent: "member", level: "warning", reason: "first_signal_timeout" });
    // No status flip to "dead" anywhere.
    expect(events.some((e) => e.kind === "agent_status" && e.status === "dead")).toBe(false);

    // A late first signal + natural completion still works (turn was never aborted).
    created.member.emitUpdate();
    created.member.finish();
    await prompt;
    expect((cp as any).mesh.status("member")).toBe("ready");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a quiet turn keeps re-warning with backoff while it stays silent", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-rewarn-"));
  const created: Record<string, HealthConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    const prompt = cp.prompt("member", "still silent");
    await waitUntil(() => warnings(events).length >= 2, 2000);
    expect(created.member.killed).toBe(false);
    expect(created.member.cancels).toBe(0);
    created.member.finish();
    await prompt;
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("first update before the deadline clears the quiet-warning timer", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-update-"));
  const created: Record<string, HealthConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    const prompt = cp.prompt("member", "respond eventually");
    await waitUntil(() => !!created.member.active);
    created.member.emitUpdate();
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(created.member.killed).toBe(false);
    expect((cp as any).mesh.status("member")).toBe("ready");
    expect(warnings(events).length).toBe(0);

    created.member.finish();
    await prompt;
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a mail-woken quiet turn keeps the mail persisted, sends NO delivery-failed receipt, and is not killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-mail-"));
  const created: Record<string, HealthConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    const res = await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "please respond");
    expect(res).toBe("queued for member as #1; wake scheduled");

    await waitUntil(() => warnings(events).some((e) => e.agent === "member"));

    // No kill, no cancel, no delivery-failed receipt back to the router.
    expect(created.member.killed).toBe(false);
    expect(created.member.cancels).toBe(0);
    expect(created.router.prompts.some((p) => p.includes("[DELIVERY FAILED]"))).toBe(false);

    // The mail is still persisted (the member is processing it, not failed).
    const memberMail = await readMailFor("member", { mailboxPath: join(root, "mailbox.ndjson") });
    expect(memberMail.map((m) => m.body)).toEqual(["please respond"]);

    // The quiet warning is surfaced as a health note in mesh status (not a failure).
    const status = (cp as any).meshStatusText("router");
    expect(status).toContain("last health note: first_signal_timeout");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("claude raw sdk retry and compaction signals emit health events and suppress the quiet warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-signals-"));
  const created: Record<string, HealthConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    const prompt = cp.prompt("router", "slow but alive");
    await waitUntil(() => !!created.router.active);
    created.router.emitExt("_claude/sdkMessage", {
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 25000,
      error: "rate_limit",
    });
    created.router.emitExt("_claude/sdkMessage", {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1781162400000, rateLimitType: "tokens", utilization: 0.5 },
    });
    created.router.emitExt("_claude/sdkMessage", {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", resetsAt: 1781162400000, rateLimitType: "tokens", utilization: 0.92 },
    });
    created.router.emitExt("_claude/sdkMessage", { type: "system", subtype: "status", status: "compacting" });
    created.router.emitExt("_claude/sdkMessage", {
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
    });
    created.router.emitExt("_claude/sdkMessage", {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 120000, post_tokens: 45000, duration_ms: 2200 },
    });

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(created.router.killed).toBe(false);
    expect((cp as any).mesh.status("router")).toBe("ready");
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_health_signal", agent: "router", signal: "retrying", detail: expect.objectContaining({ attempt: 2, retryDelayMs: 25000, reason: "rate_limit" }) }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_health_signal", agent: "router", signal: "rate_limited", detail: expect.objectContaining({ status: "allowed_warning", resetsAt: 1781162400000, utilization: 0.92 }) }));
    expect(events.filter((e) => e.kind === "agent_health_signal" && e.signal === "rate_limited")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_health_signal", agent: "router", signal: "compacting" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_health_signal", agent: "router", signal: "compact_done", detail: { outcome: "success" } }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_health_signal", agent: "router", signal: "compact_done", detail: expect.objectContaining({ trigger: "auto", preTokens: 120000, postTokens: 45000, durationMs: 2200 }) }));
    expect(warnings(events).length).toBe(0);

    created.router.finish();
    await prompt;
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
