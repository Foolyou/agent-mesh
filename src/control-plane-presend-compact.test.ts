import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { AgentTurn, MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";

const config: MeshConfig = {
  name: "presend-compact",
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

/** Mirrors AcpAgentConnection's serialized prompt queue: one in-flight turn, the rest
 *  queued, removeQueued drops queued jobs only. `prompts` records every prompt text in the
 *  order the control plane sent it, so we can assert compact-before-real sequencing. */
class QueueingConnection {
  inFlight: Job[] = [];
  queue: Job[] = [];
  prompts: { text: string; turn?: AgentTurn }[] = [];

  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `s-${this.opts.id}` };
  }
  prompt(text: string, _images?: unknown, turn?: AgentTurn): Promise<unknown> {
    this.prompts.push({ text, turn });
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
  /** Complete the in-flight turn and promote the next queued one (as the real FIFO does). */
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
  async setConfigOption(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {}
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function withPlane(
  fn: (cp: ControlPlane, conns: Record<string, QueueingConnection>, events: any[]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mesh-presend-compact-"));
  const conns: Record<string, QueueingConnection> = {};
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 0,
    connectionFactory: (opts) => {
      const conn = new QueueingConnection(opts);
      conns[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    await fn(cp, conns, events);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
}

/** Seed an agent as over-threshold with /compact advertised WITHOUT routing through
 *  onContextUsage, so the reactive (idle) auto-compact path does not also fire — isolating
 *  the pre-send guard under test. */
function seedOverThreshold(cp: ControlPlane, agent: string): void {
  (cp as any).agentAdvertisedCommands.set(agent, new Set(["compact"]));
  (cp as any).agentContextUsage.set(agent, { used: 90_000, size: 100_000, percent: 0.9, updatedAt: Date.now() });
}

const texts = (conn: QueueingConnection): string[] => conn.prompts.map((p) => p.text);
const compactStarts = (events: any[]): any[] => events.filter((e) => e.kind === "compact_started");

test("over-threshold normal prompt compacts exactly once, before the real prompt", async () => {
  await withPlane(async (cp, conns, events) => {
    const member = conns.member;
    seedOverThreshold(cp, "member");

    const real = cp.prompt("member", "real work");
    await tick();
    // The real prompt is held until /compact completes: only /compact has been sent.
    expect(texts(member)).toEqual(["/compact"]);
    expect(member.inFlight[0]?.text).toBe("/compact");

    member.finishCurrent(); // /compact turn ends -> real prompt is released
    await tick();
    expect(texts(member)).toEqual(["/compact", expect.stringContaining("real work")]);
    expect(compactStarts(events)).toHaveLength(1);
    expect(compactStarts(events)[0].reason).toBe("pre-send");

    member.finishCurrent();
    await real;
  });
});

test("steer prompts skip the pre-send compact (they must jump the queue)", async () => {
  await withPlane(async (cp, conns, events) => {
    const member = conns.member;
    seedOverThreshold(cp, "member");

    // steer === true path
    void (cp as any).promptWithResumeFallback("member", "steer body", [], true);
    await tick();

    expect(texts(member)).toEqual([expect.stringContaining("steer body")]);
    expect(texts(member)).not.toContain("/compact");
    expect(compactStarts(events)).toHaveLength(0);

    member.finishCurrent();
  });
});

test("sendBarePrompt does not recurse into the pre-send guard", async () => {
  await withPlane(async (cp, conns, events) => {
    const member = conns.member;
    seedOverThreshold(cp, "member");

    const p = (cp as any).sendBarePrompt("member", "/compact");
    await tick();
    // Exactly the one explicit bare prompt — no second guard-injected /compact.
    expect(texts(member)).toEqual(["/compact"]);
    expect(compactStarts(events)).toHaveLength(0); // bare prompt itself does not emit compact_started

    member.finishCurrent();
    await p;
  });
});

test("reactive + pre-send eligibility back-to-back produce a single compact", async () => {
  await withPlane(async (cp, conns, events) => {
    const member = conns.member;
    // Reactive path: usage update while idle triggers auto-threshold compaction.
    member.opts.onAvailableCommands?.(["compact"]);
    member.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9 });
    await tick();
    expect(texts(member)).toEqual(["/compact"]);
    expect(compactStarts(events)).toHaveLength(1);
    expect(compactStarts(events)[0].reason).toBe("auto-threshold");

    // A real prompt arrives while that compact is still in flight: it must coalesce, not
    // queue a second /compact.
    const real = cp.prompt("member", "real work");
    await tick();
    expect(texts(member)).toEqual(["/compact"]); // still one compact, real is held

    member.finishCurrent(); // compact ends -> real released
    await tick();
    expect(texts(member)).toEqual(["/compact", expect.stringContaining("real work")]);
    expect(compactStarts(events)).toHaveLength(1); // never a second compact

    member.finishCurrent(); // real turn ends -> finishTurn re-checks, but cooldown blocks
    await real;
    await tick();
    expect(compactStarts(events)).toHaveLength(1);
  });
});

test("busy target over threshold compacts ahead of the woken real prompt", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    // Member is mid-turn (no usage yet, so this first prompt is not guarded).
    const busy = cp.prompt("member", "busy turn");
    await tick();
    expect(texts(member)).toEqual([expect.stringContaining("busy turn")]);

    // Now context is over threshold and a new real prompt arrives.
    seedOverThreshold(cp, "member");
    const real = cp.prompt("member", "real work");
    await tick();
    // /compact is queued behind the busy turn; the real prompt is held by the guard.
    expect(texts(member)).toEqual([expect.stringContaining("busy turn"), "/compact"]);
    expect(member.queue.map((j) => j.text)).toEqual(["/compact"]);

    member.finishCurrent(); // busy ends -> /compact promoted to in-flight
    await tick();
    expect(texts(member)).toEqual([expect.stringContaining("busy turn"), "/compact"]);

    member.finishCurrent(); // /compact ends -> real released
    await tick();
    expect(texts(member)).toEqual([
      expect.stringContaining("busy turn"),
      "/compact",
      expect.stringContaining("real work"),
    ]);

    member.finishCurrent();
    await busy;
    await real;
  });
});

test("check_mail consuming queued mail does not remove a queued system /compact", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    const busy = cp.prompt("member", "busy turn");
    await tick();

    // Queue a system /compact behind the busy turn.
    const compactP = (cp as any).sendBarePrompt("member", "/compact");
    await tick();
    expect(member.queue.map((j) => j.turn?.source)).toEqual(["system"]);

    // Deliver mail -> a mail turn queues behind the /compact.
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "ping");
    expect(member.queue.map((j) => j.turn?.source)).toEqual(["system", "mail"]);

    // Member reads the mail in its current turn: only the mail turn is dropped.
    await (cp as any).handleCheckMail({ agentId: "member", role: "member" });
    expect(member.queue.map((j) => j.turn?.source)).toEqual(["system"]);

    member.finishCurrent(); // busy ends -> /compact runs
    member.finishCurrent(); // /compact ends
    await busy;
    await compactP;
  });
});

test("a failed /compact still delivers the real prompt", async () => {
  await withPlane(async (cp, conns, events) => {
    const member = conns.member;
    seedOverThreshold(cp, "member");
    (cp as any).sendBarePrompt = async () => {
      throw new Error("compact boom");
    };

    const real = cp.prompt("member", "real work");
    await tick();
    // Compact failed (sendBarePrompt threw, so no "/compact" reached the connection), but the
    // real prompt is delivered anyway.
    expect(texts(member)).toEqual([expect.stringContaining("real work")]);
    expect(events.some((e) => e.kind === "compact_failed")).toBe(true);

    member.finishCurrent();
    await real;
  });
});

test("drainPendingMail applies the pre-send compact guard before its direct prompt", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    seedOverThreshold(cp, "member");

    (cp as any).drainPendingMail("member");
    await tick();
    // Guard injects /compact before the drain prompt's direct conn.prompt.
    expect(texts(member)).toEqual(["/compact"]);

    member.finishCurrent(); // /compact ends -> drain prompt released
    await tick();
    expect(texts(member)).toEqual(["/compact", expect.stringContaining("pending mail")]);

    member.finishCurrent();
  });
});
