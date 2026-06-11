import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { AgentTurn, MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { readMailFor, sendMail } from "./mailbox";

const config: MeshConfig = {
  name: "mail-consume",
  agents: [
    { id: "router", harness: "claude", project: ".", role: "router" },
    { id: "member", harness: "codex", project: ".", role: "member" },
  ],
  edges: [
    { from: "router", to: "member" },
    { from: "member", to: "router" },
  ],
};

type Job = { text: string; turn?: AgentTurn; resolve: (r: unknown) => void };

/** Mirrors AcpAgentConnection's serialized prompt queue: one in-flight turn, the
 *  rest queued, removeQueued drops queued jobs only. */
class QueueingConnection {
  inFlight: Job[] = [];
  queue: Job[] = [];

  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `s-${this.opts.id}` };
  }
  prompt(text: string, _images?: unknown, turn?: AgentTurn): Promise<unknown> {
    return new Promise((resolve) => {
      const job: Job = { text, turn, resolve };
      if (turn) this.opts.onPromptQueued?.(turn);
      if (this.inFlight.length === 0) {
        this.inFlight.push(job);
        if (turn) this.opts.onPromptStarted?.(turn);
      } else {
        this.queue.push(job);
      }
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
  finishCurrent(): void {
    const job = this.inFlight.shift();
    job?.resolve({ stopReason: "end_turn" });
    const next = this.queue.shift();
    if (next) {
      this.inFlight.push(next);
      if (next.turn) this.opts.onPromptStarted?.(next.turn);
    }
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {}
}

function makePlane(root: string, created: Record<string, QueueingConnection>) {
  return new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = new QueueingConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });
}

test("check_mail consumes queued mail turns: emits consumed, clears queue, never re-delivers", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-consume-"));
  const created: Record<string, QueueingConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    // Member is busy on a long operator turn.
    void cp.prompt("member", "long work");
    expect(created.member.inFlight).toHaveLength(1);

    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "ping");
    const queuedEvent = events.find((e) => e.kind === "agent_turn" && e.phase === "queued" && e.turn.agent === "member" && e.turn.source === "mail");
    expect(queuedEvent).toBeDefined();
    expect(queuedEvent.turn.mailId).toBeString();
    expect(created.member.queue).toHaveLength(1);

    // Member reads the mail inside its current turn.
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("from router: ping");

    const consumed = events.find((e) => e.kind === "agent_turn" && e.phase === "consumed" && e.turn.agent === "member");
    expect(consumed).toBeDefined();
    expect(consumed.turn.id).toBe(queuedEvent.turn.id);
    expect(created.member.queue).toHaveLength(0);
    expect(cp.snapshotEvents()).not.toContainEqual(
      expect.objectContaining({ kind: "agent_turn", phase: "queued", turn: expect.objectContaining({ id: queuedEvent.turn.id }) }),
    );

    // When the busy turn ends, the stale mail prompt must not start.
    created.member.finishCurrent();
    expect(created.member.inFlight).toHaveLength(0);
    expect(events.filter((e) => e.kind === "agent_turn" && e.phase === "started" && e.turn.source === "mail")).toHaveLength(0);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("check_mail leaves queued operator turns and unrelated mail turns alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-consume-other-"));
  const created: Record<string, QueueingConnection> = {};
  const cp = makePlane(root, created);

  try {
    await cp.start();
    void cp.prompt("member", "long work");
    void cp.prompt("member", "queued operator prompt");
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "ping");
    expect(created.member.queue).toHaveLength(2);

    await (cp as any).handleCheckMail({ agentId: "member", role: "member" });
    expect(created.member.queue).toHaveLength(1);
    expect(created.member.queue[0].turn?.source).toBe("operator");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("removeQueuedTurn drops only a queued operator turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-queue-remove-"));
  const created: Record<string, QueueingConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    void cp.prompt("member", "long work");
    void cp.prompt("member", "queued operator prompt");
    const queuedEvent = events.find((e) => e.kind === "agent_turn" && e.phase === "queued" && e.turn.source === "operator" && e.turn.text === "queued operator prompt");
    expect(queuedEvent).toBeDefined();
    expect(created.member.queue).toHaveLength(1);

    expect(cp.removeQueuedTurn("member", queuedEvent.turn.id)).toBe(true);

    const removed = events.find((e) => e.kind === "agent_turn" && e.phase === "removed" && e.turn.id === queuedEvent.turn.id);
    expect(removed).toBeDefined();
    expect(created.member.queue).toHaveLength(0);
    expect(cp.snapshotEvents()).not.toContainEqual(
      expect.objectContaining({ kind: "agent_turn", phase: "queued", turn: expect.objectContaining({ id: queuedEvent.turn.id }) }),
    );

    created.member.finishCurrent();
    expect(created.member.inFlight).toHaveLength(0);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("removeQueuedTurn refuses queued mail turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-queue-remove-mail-"));
  const created: Record<string, QueueingConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    void cp.prompt("member", "long work");
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "ping");
    const queuedEvent = events.find((e) => e.kind === "agent_turn" && e.phase === "queued" && e.turn.source === "mail");
    expect(queuedEvent).toBeDefined();

    expect(cp.removeQueuedTurn("member", queuedEvent.turn.id)).toBe(false);
    expect(created.member.queue).toHaveLength(1);
    expect(cp.snapshotEvents()).toContainEqual(
      expect.objectContaining({ kind: "agent_turn", phase: "queued", turn: expect.objectContaining({ id: queuedEvent.turn.id }) }),
    );
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("removeQueuedTurn can drop an operator steer but not a peer steer", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-queue-remove-steer-"));
  const created: Record<string, QueueingConnection> = {};
  const cp = makePlane(root, created);
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    void cp.prompt("member", "long work");
    await cp.steer("member", "operator urgent");
    void (cp as any).steerWake("member", "router", "peer urgent");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const operatorSteer = events.find((e) => e.kind === "agent_turn" && e.phase === "queued" && e.turn.source === "steer" && e.turn.from === "operator");
    const peerSteer = events.find((e) => e.kind === "agent_turn" && e.phase === "queued" && e.turn.source === "steer" && e.turn.from === "router");
    expect(operatorSteer).toBeDefined();
    expect(peerSteer).toBeDefined();

    expect(cp.removeQueuedTurn("member", operatorSteer.turn.id)).toBe(true);
    expect(cp.removeQueuedTurn("member", peerSteer.turn.id)).toBe(false);
    expect(created.member.queue.map((job) => job.turn?.id)).toContain(peerSteer.turn.id);
    expect(created.member.queue.map((job) => job.turn?.id)).not.toContain(operatorSteer.turn.id);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("wake skips mail already consumed by check_mail (send/check race)", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-consume-race-"));
  const created: Record<string, QueueingConnection> = {};
  const cp = makePlane(root, created);

  try {
    await cp.start();
    // Mail lands in the durable mailbox without a wake (simulates the window
    // between handleSendMail's mailbox write and its wake()).
    await sendMail({ mailboxPath: join(root, "mailbox.ndjson"), mesh: config.name, from: "router", to: "member", body: "racy" });
    const [mail] = await readMailFor("member", { mailboxPath: join(root, "mailbox.ndjson") });
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("from router: racy");

    const before = created.member.inFlight.length + created.member.queue.length;
    (cp as any).wake("member", "router", "racy", mail.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created.member.inFlight.length + created.member.queue.length).toBe(before);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
