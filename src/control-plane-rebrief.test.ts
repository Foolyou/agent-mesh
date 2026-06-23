import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { AgentTurn, MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";

// B-core: post-compaction auto-rebrief. A compaction may summarize the original [MESH BRIEFING]
// out of the harness's history, so a SUCCESSFUL /compact (stopReason "end_turn") sets needsRebrief,
// and the next real outbound prompt re-injects a fresh briefing via compose(). A cancel/supersede
// (which also resolves the prompt but did NOT compact) must NOT rebrief.

const config: MeshConfig = {
  name: "rebrief",
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

/** Serialized prompt queue mirroring AcpAgentConnection: one in-flight turn, the rest queued.
 *  finishCurrent(stopReason) lets a test resolve the in-flight turn with any stop reason, so we can
 *  drive end_turn / cancelled / superseded through runCompact's success gate. */
class QueueingConnection {
  inFlight: Job[] = [];
  queue: Job[] = [];
  prompts: { text: string; turn?: AgentTurn }[] = [];

  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> { return {}; }
  async newSession(): Promise<unknown> { return { sessionId: `s-${this.opts.id}` }; }
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
  /** Complete the in-flight turn with the given stopReason and promote the next queued one. */
  finishCurrent(stopReason: string = "end_turn"): void {
    const job = this.inFlight.shift();
    job?.resolve({ stopReason });
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
  const root = await mkdtemp(join(tmpdir(), "mesh-rebrief-"));
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
 *  onContextUsage, isolating the pre-send guard from the reactive path. */
function seedOverThreshold(cp: ControlPlane, agent: string): void {
  (cp as any).agentAdvertisedCommands.set(agent, new Set(["compact"]));
  (cp as any).agentContextUsage.set(agent, { used: 90_000, size: 100_000, percent: 0.9, updatedAt: Date.now() });
}

const REBRIEF_MARK = "(Context was compacted;";
const texts = (conn: QueueingConnection): string[] => conn.prompts.map((p) => p.text);
const lastText = (conn: QueueingConnection): string => conn.prompts[conn.prompts.length - 1]?.text ?? "";

test("successful /compact (end_turn) sets needsRebrief and the next real prompt carries a fresh briefing", async () => {
  await withPlane(async (cp, conns, events) => {
    const member = conns.member;
    seedOverThreshold(cp, "member");

    const real = cp.prompt("member", "real work");
    await tick();
    expect(texts(member)).toEqual(["/compact"]); // real prompt held until /compact settles

    member.finishCurrent("end_turn"); // success -> needsRebrief
    await tick();

    expect(events).toContainEqual(expect.objectContaining({ kind: "compact_completed", agent: "member" }));
    // The same held real prompt is released AND carries the rebrief prefix + a fresh briefing.
    const delivered = lastText(member);
    expect(delivered).toContain(REBRIEF_MARK);
    expect(delivered).toContain("[MESH BRIEFING]");
    expect(delivered).toContain("real work");
    // Flag is one-shot: a subsequent prompt is no longer rebriefed.
    member.finishCurrent("end_turn");
    await real;
    const again = cp.prompt("member", "second task");
    await tick();
    expect(lastText(member)).not.toContain(REBRIEF_MARK);
    member.finishCurrent("end_turn");
    await again;
  });
});

test("cancelled /compact does NOT emit compact_completed and does NOT rebrief", async () => {
  await withPlane(async (cp, conns, events) => {
    const member = conns.member;
    seedOverThreshold(cp, "member");

    const real = cp.prompt("member", "real work");
    await tick();
    expect(texts(member)).toEqual(["/compact"]);

    member.finishCurrent("cancelled"); // resolves, but did NOT compact
    await tick();

    expect(events.some((e) => e.kind === "compact_completed")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: "compact_failed", agent: "member", error: expect.stringContaining("stopReason=cancelled") }));
    // The released real prompt must NOT carry the rebrief prefix.
    expect(lastText(member)).not.toContain(REBRIEF_MARK);
    member.finishCurrent("end_turn");
    await real;
  });
});

test("superseded /compact does NOT emit compact_completed and does NOT rebrief", async () => {
  await withPlane(async (cp, conns, events) => {
    const member = conns.member;
    seedOverThreshold(cp, "member");

    const real = cp.prompt("member", "real work");
    await tick();
    expect(texts(member)).toEqual(["/compact"]);

    member.finishCurrent("superseded");
    await tick();

    expect(events.some((e) => e.kind === "compact_completed")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: "compact_failed", agent: "member", error: expect.stringContaining("stopReason=superseded") }));
    expect(lastText(member)).not.toContain(REBRIEF_MARK);
    member.finishCurrent("end_turn");
    await real;
  });
});

test("compose() consumes needsRebrief BEFORE the loaded/briefed early-returns", () => {
  // Directly exercise compose for an agent that is BOTH loaded and already briefed: the rebrief
  // must still win because it is consumed first, then cleared (one-shot).
  return withPlane(async (cp) => {
    (cp as any).loadedSessions.add("member");
    (cp as any).briefed.add("member");
    (cp as any).needsRebrief.add("member");

    const out = (cp as any).compose("member", "hello") as string;
    expect(out).toContain(REBRIEF_MARK);
    expect(out).toContain("[MESH BRIEFING]");
    expect(out).toContain("hello");

    // One-shot: needsRebrief cleared, so the next compose falls back to the loaded early-return.
    expect((cp as any).needsRebrief.has("member")).toBe(false);
    const out2 = (cp as any).compose("member", "world") as string;
    expect(out2).toBe("world");
  });
});

test("bare /compact bypasses compose and never consumes needsRebrief", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    (cp as any).needsRebrief.add("member"); // a rebrief is pending…

    const p = (cp as any).sendBarePrompt("member", "/compact");
    await tick();
    // …but the bare /compact prompt is delivered verbatim, NOT briefing-prefixed.
    expect(texts(member)).toEqual(["/compact"]);
    expect(lastText(member)).not.toContain("[MESH BRIEFING]");
    expect(lastText(member)).not.toContain(REBRIEF_MARK);
    // The pending rebrief is untouched (it rides the next REAL prompt, not the bare one).
    expect((cp as any).needsRebrief.has("member")).toBe(true);

    member.finishCurrent("end_turn");
    await p;
  });
});

test("over-threshold drainPendingMail compacts first, then the SAME drain prompt carries the rebrief", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    seedOverThreshold(cp, "member");

    (cp as any).drainPendingMail("member");
    await tick();
    expect(texts(member)).toEqual(["/compact"]); // guard injects /compact before the drain prompt

    member.finishCurrent("end_turn"); // /compact succeeds -> needsRebrief
    await tick();

    // The drain prompt is delivered AFTER the guard settled, composed at send time, so it carries
    // the rebrief — not deferred to a later prompt.
    const drain = lastText(member);
    expect(drain).toContain(REBRIEF_MARK);
    expect(drain).toContain("[MESH BRIEFING]");
    expect(drain).toContain("pending mail");

    member.finishCurrent("end_turn");
  });
});
