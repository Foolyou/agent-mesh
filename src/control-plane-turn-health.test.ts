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
    turnCancelGraceMs: 10,
    connectionFactory: (opts) => {
      const conn = new HealthConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });
}

test("started prompt with no first signal times out, cancels, then kills and marks dead", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-timeout-"));
  const created: Record<string, HealthConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    void cp.prompt("member", "hang forever").catch(() => {});

    await waitUntil(() => created.member.killed);

    expect(created.member.cancels).toBe(1);
    expect(created.member.kills).toBe(1);
    expect((cp as any).mesh.status("member")).toBe("dead");
    expect((cp as any).conns.has("member")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "agent_turn_health",
        agent: "member",
        level: "failed",
        reason: "first_signal_timeout",
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "member", activity: "idle" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("first update before deadline clears the first-signal timer", async () => {
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
    expect(events.some((e) => e.kind === "agent_turn_health")).toBe(false);

    created.member.finish();
    await prompt;
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("late timeout from an old connection does not hurt a new connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-old-conn-"));
  const created: Record<string, HealthConnection[]> = {};
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 10,
    turnCancelGraceMs: 30,
    connectionFactory: (opts) => {
      const conn = new HealthConnection(opts);
      (created[opts.id] ??= []).push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    void cp.prompt("member", "old hang").catch(() => {});
    await waitUntil(() => !!created.member?.[0]?.active);
    const oldConn = created.member[0]!;
    await new Promise((resolve) => setTimeout(resolve, 15));

    await (cp as any).ensureSpawned("member", { manual: true, forceFresh: true, drainPendingMail: false });
    const newConn = created.member[1]!;
    newConn.emitUpdate();
    newConn.finish();

    await new Promise((resolve) => setTimeout(resolve, 45));
    expect((cp as any).conns.get("member")).toBe(newConn);
    expect((cp as any).mesh.status("member")).toBe("ready");
    expect(oldConn.kills).toBe(1);
    expect(newConn.kills).toBe(0);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("stopped agent is not changed to dead by a pending turn timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-stopped-"));
  const created: Record<string, HealthConnection> = {};
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 10,
    turnCancelGraceMs: 30,
    connectionFactory: (opts) => {
      const conn = new HealthConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    void cp.prompt("member", "old hang").catch(() => {});
    await waitUntil(() => !!created.member.active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await cp.stopAgent("member");

    await new Promise((resolve) => setTimeout(resolve, 45));
    expect((cp as any).mesh.status("member")).toBe("stopped");
    expect((cp as any).conns.has("member")).toBe(false);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("mail wake timeout keeps mail persisted, sends delivery-failed receipt, and reports mesh health", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-mail-"));
  const created: Record<string, HealthConnection> = {};
  const cp = makePlane(root, created);

  try {
    await cp.start();
    const res = await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "please respond");
    expect(res).toBe("queued for member as #1; wake scheduled");

    await waitUntil(() => created.member.killed);
    await waitUntil(() => created.router.prompts.some((prompt) => prompt.includes("[DELIVERY FAILED]")));

    const memberMail = await readMailFor("member", { mailboxPath: join(root, "mailbox.ndjson") });
    expect(memberMail.map((m) => m.body)).toEqual(["please respond"]);

    const routerMail = await readMailFor("router", { mailboxPath: join(root, "mailbox.ndjson") });
    expect(routerMail.map((m) => m.body).join("\n")).toContain("[DELIVERY FAILED]");
    expect(routerMail.map((m) => m.body).join("\n")).toContain("mail #1 is still persisted");

    const status = (cp as any).meshStatusText("router");
    expect(status).toContain("last health failure: first_signal_timeout");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("claude raw sdk retry and compaction signals emit health events and suppress first-signal timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-turn-health-signals-"));
  const created: Record<string, HealthConnection> = {};
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 10,
    turnCancelGraceMs: 10,
    connectionFactory: (opts) => {
      const conn = new HealthConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });
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
      rate_limit_info: { status: "warning", resetsAt: "2026-06-11T10:00:00.000Z", rateLimitType: "tokens", utilization: 0.92 },
    });
    created.router.emitExt("_claude/sdkMessage", { type: "system", subtype: "status", status: "compacting" });
    created.router.emitExt("_claude/sdkMessage", { type: "system", subtype: "compact_boundary", phase: "end" });

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(created.router.killed).toBe(false);
    expect((cp as any).mesh.status("router")).toBe("ready");
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_health_signal", agent: "router", signal: "retrying", detail: expect.objectContaining({ attempt: 2, retryDelayMs: 25000, reason: "rate_limit" }) }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_health_signal", agent: "router", signal: "rate_limited", detail: expect.objectContaining({ status: "warning", utilization: 0.92 }) }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_health_signal", agent: "router", signal: "compacting" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_health_signal", agent: "router", signal: "compact_done" }));
    expect(events.some((e) => e.kind === "agent_turn_health" && e.reason === "first_signal_timeout")).toBe(false);

    created.router.finish();
    await prompt;
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
