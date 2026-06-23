import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { AgentTurn, AutoCompactSettings, MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";

class AutoCompactConnection {
  prompts: Array<{ text: string; turn?: AgentTurn }> = [];
  holdNextPrompt = false;
  releasePrompt?: () => void;

  constructor(readonly opts: AcpConnectionOptions) {}

  async start(): Promise<void> {}
  async initialize(): Promise<unknown> { return {}; }
  async newSession(): Promise<unknown> { return { sessionId: `s-${this.opts.id}` }; }
  async prompt(text: string, _images: unknown[] = [], turn?: AgentTurn): Promise<unknown> {
    this.prompts.push({ text, turn });
    if (turn) this.opts.onPromptStarted?.(turn);
    if (this.holdNextPrompt) {
      this.holdNextPrompt = false;
      await new Promise<void>((resolve) => { this.releasePrompt = resolve; });
    }
    return { stopReason: "end_turn" };
  }
  async steerPrompt(text: string, images: unknown[] = [], turn?: AgentTurn): Promise<unknown> {
    return this.prompt(text, images, turn);
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void { this.releasePrompt?.(); }
}

function config(root: string, autoCompact?: AutoCompactSettings): MeshConfig {
  return {
    name: "auto-compact",
    autoCompact,
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
  };
}

async function withControlPlane(
  autoCompact: AutoCompactSettings | undefined,
  fn: (cp: ControlPlane, conn: AutoCompactConnection, events: any[]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cp-auto-compact-"));
  let conn: AutoCompactConnection | undefined;
  const cp = new ControlPlane(config(root, autoCompact), {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 0,
    connectionFactory: (opts) => {
      conn = new AutoCompactConnection(opts);
      return conn as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    if (!conn) throw new Error("connection missing");
    await fn(cp, conn, events);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("auto compact triggers bare prompt when usage exceeds threshold and compact is advertised", async () => {
  await withControlPlane(undefined, async (cp, conn, events) => {
    conn.opts.onAvailableCommands?.(["compact", "init"]);
    conn.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9, source: "usage_update" });
    await tick();

    expect(conn.prompts.map((p) => p.text)).toEqual(["/compact"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "compact_started", agent: "router", reason: "auto-threshold" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "compact_completed", agent: "router" }));
  });
});

test("auto compact warns when compact command is not advertised", async () => {
  await withControlPlane(undefined, async (_cp, conn, events) => {
    conn.opts.onAvailableCommands?.(["init"]);
    conn.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9, source: "usage_update" });
    await tick();

    expect(conn.prompts).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "near_context_limit_no_compact",
      agent: "router",
      usagePercent: 0.9,
    }));
  });
});

test("auto compact waits when agent has an in-flight turn", async () => {
  await withControlPlane(undefined, async (cp, conn) => {
    conn.holdNextPrompt = true;
    const prompt = cp.prompt("router", "busy");
    await tick();

    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9, source: "usage_update" });
    await tick();

    expect(conn.prompts.map((p) => p.text)).toEqual([expect.stringContaining("busy")]);
    conn.releasePrompt?.();
    await prompt;
  });
});

test("auto compact rechecks high usage when the agent returns idle", async () => {
  await withControlPlane(undefined, async (cp, conn, events) => {
    conn.holdNextPrompt = true;
    const prompt = cp.prompt("router", "busy");
    await tick();

    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9, source: "usage_update" });
    await tick();
    expect(conn.prompts.map((p) => p.text)).toEqual([expect.stringContaining("busy")]);

    conn.releasePrompt?.();
    await prompt;
    await tick();

    expect(conn.prompts.map((p) => p.text)).toEqual([expect.stringContaining("busy"), "/compact"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "compact_started", agent: "router", reason: "auto-threshold" }));
  });
});

test("auto compact respects compact cooldown", async () => {
  await withControlPlane(undefined, async (_cp, conn) => {
    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9, source: "usage_update" });
    await tick();
    conn.opts.onContextUsage?.({ used: 91_000, size: 100_000, percent: 0.91, source: "usage_update" });
    await tick();

    expect(conn.prompts.map((p) => p.text)).toEqual(["/compact"]);
  });
});

test("auto compact can be disabled", async () => {
  await withControlPlane({ enabled: false, threshold: "90%" }, async (_cp, conn, events) => {
    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9, source: "usage_update" });
    await tick();

    expect(conn.prompts).toHaveLength(0);
    expect(events.some((e) => e.kind === "compact_started")).toBe(false);
  });
});

test("auto compact honors configured threshold", async () => {
  await withControlPlane({ enabled: true, threshold: "95%" }, async (_cp, conn) => {
    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9, source: "usage_update" });
    await tick();
    expect(conn.prompts).toHaveLength(0);

    conn.opts.onContextUsage?.({ used: 96_000, size: 100_000, percent: 0.96, source: "usage_update" });
    await tick();
    expect(conn.prompts.map((p) => p.text)).toEqual(["/compact"]);
  });
});

test("auto compact emits failure when bare prompt fails", async () => {
  await withControlPlane(undefined, async (cp, conn, events) => {
    cp.sendBarePrompt = async () => { throw new Error("compact failed"); };
    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9, source: "usage_update" });
    await tick();

    expect(events).toContainEqual(expect.objectContaining({ kind: "compact_failed", agent: "router", error: "Error: compact failed" }));
  });
});

test("fresh spawn clears last compact and near-limit warning timestamps", async () => {
  await withControlPlane(undefined, async (cp, conn) => {
    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9, source: "usage_update" });
    await tick();
    expect((cp as any).meshStatusText("router")).toContain("\"lastCompactAt\":");

    await cp.respawnAgent("router", "force");
    const parsed = JSON.parse((cp as any).meshStatusText("router").match(/\{[\s\S]*$/)![0]);
    expect(parsed.agents[0].lastCompactAt).toBeNull();
    expect(parsed.agents[0].lastNearLimitWarnedAt).toBeNull();
  });
});

test("auto compact skips small context windows", async () => {
  await withControlPlane(undefined, async (_cp, conn, events) => {
    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 57_000, size: 60_000, percent: 0.95, source: "usage_update" });
    await tick();

    expect(conn.prompts).toHaveLength(0);
    expect(events.some((e) => e.kind === "compact_started")).toBe(false);
  });
});
