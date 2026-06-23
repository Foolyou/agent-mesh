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

// ── B-heuristic: usage-drop rebrief (covers manual /compact + harness-internal compaction) ──────

const usageFrame = (used: number, size: number, source: "usage_update" | "token_count") =>
  ({ used, size, percent: used / size, source });

test("usage_update sharp drop schedules a rebrief; next real prompt carries the briefing", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    // Prior occupancy high, then a sharp drop (a compaction the controller did NOT trigger).
    member.opts.onContextUsage?.(usageFrame(90_000, 100_000, "usage_update"));
    member.opts.onContextUsage?.(usageFrame(8_000, 100_000, "usage_update"));
    expect((cp as any).needsRebrief.has("member")).toBe(true);

    const p = cp.prompt("member", "after manual compact");
    await tick();
    expect(lastText(member)).toContain(REBRIEF_MARK);
    expect(lastText(member)).toContain("[MESH BRIEFING]");
    member.finishCurrent("end_turn");
    await p;
  });
});

test("token_count drop NEVER schedules a rebrief (per-request, not cumulative)", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    member.opts.onContextUsage?.(usageFrame(90_000, 100_000, "usage_update")); // prior occupancy
    // A big token_count fall is normal per-request noise — must be ignored.
    member.opts.onContextUsage?.(usageFrame(3_000, 200_000, "token_count"));
    expect((cp as any).needsRebrief.has("member")).toBe(false);

    const p = cp.prompt("member", "next");
    await tick();
    expect(lastText(member)).not.toContain(REBRIEF_MARK);
    member.finishCurrent("end_turn");
    await p;
  });
});

test("a token_count frame between two usage_update frames does NOT poison the drop baseline", async () => {
  // Regression: the heuristic must keep a usage_update-only baseline. Otherwise the token_count
  // frame overwrites the shared baseline and the real usage_update compaction drop is masked.
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    member.opts.onContextUsage?.(usageFrame(90_000, 100_000, "usage_update")); // baseline = 90k
    member.opts.onContextUsage?.(usageFrame(3_000, 200_000, "token_count")); // must NOT move baseline
    member.opts.onContextUsage?.(usageFrame(8_000, 100_000, "usage_update")); // real compaction drop vs 90k
    expect((cp as any).needsRebrief.has("member")).toBe(true);

    const p = cp.prompt("member", "after manual compact");
    await tick();
    expect(lastText(member)).toContain(REBRIEF_MARK);
    member.finishCurrent("end_turn");
    await p;
  });
});

test("usage_update high then successive token_count lows do NOT rebrief", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    member.opts.onContextUsage?.(usageFrame(90_000, 100_000, "usage_update")); // baseline = 90k
    member.opts.onContextUsage?.(usageFrame(3_000, 200_000, "token_count"));
    member.opts.onContextUsage?.(usageFrame(1_000, 200_000, "token_count"));
    expect((cp as any).needsRebrief.has("member")).toBe(false);
  });
});

test("usage_update drops that are too small, below the floor, or rising do not rebrief", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    // Below the prior-occupancy floor (30k < 40k): a drop from here is ignored.
    member.opts.onContextUsage?.(usageFrame(30_000, 100_000, "usage_update"));
    member.opts.onContextUsage?.(usageFrame(2_000, 100_000, "usage_update"));
    expect((cp as any).needsRebrief.has("member")).toBe(false);
    // Rising usage: not a drop.
    member.opts.onContextUsage?.(usageFrame(90_000, 100_000, "usage_update"));
    expect((cp as any).needsRebrief.has("member")).toBe(false);
    // A shallow fall (90k -> 60k, > 50%): not sharp enough.
    member.opts.onContextUsage?.(usageFrame(60_000, 100_000, "usage_update"));
    expect((cp as any).needsRebrief.has("member")).toBe(false);
  });
});

test("controller compact event + post-compact usage drop produce exactly ONE rebrief (dedup)", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    seedOverThreshold(cp, "member"); // advertises compact + seeds used=90_000
    // Establish a real usage_update baseline so the post-compact drop below genuinely QUALIFIES —
    // the cooldown (not a missing baseline) is what must suppress the second rebrief.
    (cp as any).agentLastUsageUpdateUsed.set("member", 90_000);

    const real = cp.prompt("member", "real work");
    await tick();
    expect(texts(member)).toEqual(["/compact"]);

    member.finishCurrent("end_turn"); // B-core: scheduleRebrief (flag + cooldown stamp)
    // Harness emits its post-compact usage drop right after (90k -> 5k, a qualifying drop) — it must
    // be SUPPRESSED by the cooldown, not re-arm needsRebrief for a second rebrief.
    member.opts.onContextUsage?.(usageFrame(5_000, 100_000, "usage_update"));
    await tick();

    const first = lastText(member);
    expect(first).toContain(REBRIEF_MARK); // the held real prompt carries the (single) rebrief
    member.finishCurrent("end_turn");
    await real;

    // Second prompt must NOT be rebriefed again — the flag was consumed once and the drop was deduped.
    const p2 = cp.prompt("member", "again");
    await tick();
    expect(lastText(member)).not.toContain(REBRIEF_MARK);
    member.finishCurrent("end_turn");
    await p2;
  });
});

test("multi-frame usage drops within cooldown collapse to a single rebrief", async () => {
  await withPlane(async (cp, conns) => {
    const member = conns.member;
    member.opts.onContextUsage?.(usageFrame(90_000, 100_000, "usage_update"));
    member.opts.onContextUsage?.(usageFrame(8_000, 100_000, "usage_update")); // fires
    expect((cp as any).needsRebrief.has("member")).toBe(true);

    // Consume the rebrief.
    const p = cp.prompt("member", "x");
    await tick();
    expect(lastText(member)).toContain(REBRIEF_MARK);
    member.finishCurrent("end_turn");
    await p;
    expect((cp as any).needsRebrief.has("member")).toBe(false);

    // A second qualifying drop within the cooldown must NOT re-arm the flag.
    member.opts.onContextUsage?.(usageFrame(90_000, 100_000, "usage_update"));
    member.opts.onContextUsage?.(usageFrame(8_000, 100_000, "usage_update"));
    expect((cp as any).needsRebrief.has("member")).toBe(false);
  });
});
