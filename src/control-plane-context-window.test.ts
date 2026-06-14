import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { AgentTurn, AutoCompactSettings, MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";

// A session that advertises a switchable model list so deriveStandardModels populates
// sessionModels (and ControlPlane.setModel can later change the current model).
function sessionWithModels(id: string) {
  return {
    sessionId: `s-${id}`,
    models: {
      currentModelId: "claude-opus-4-8",
      availableModels: [
        { modelId: "claude-opus-4-8", name: "Claude Opus 4.8" },
        { modelId: "claude-opus-4-1", name: "Claude Opus 4.1" },
        { modelId: "mystery-model", name: "Mystery" },
      ],
    },
  };
}

class WindowConnection {
  prompts: Array<{ text: string; turn?: AgentTurn }> = [];

  constructor(readonly opts: AcpConnectionOptions) {}

  async start(): Promise<void> {}
  async initialize(): Promise<unknown> { return {}; }
  async newSession(): Promise<unknown> { return sessionWithModels(this.opts.id); }
  async prompt(text: string, _images: unknown[] = [], turn?: AgentTurn): Promise<unknown> {
    this.prompts.push({ text, turn });
    if (turn) this.opts.onPromptStarted?.(turn);
    return { stopReason: "end_turn" };
  }
  async steerPrompt(text: string, images: unknown[] = [], turn?: AgentTurn): Promise<unknown> {
    return this.prompt(text, images, turn);
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {}
}

function config(root: string, autoCompact?: AutoCompactSettings): MeshConfig {
  return {
    name: "ctx-window",
    autoCompact,
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
  };
}

async function withControlPlane(
  fn: (cp: ControlPlane, conn: WindowConnection, events: any[]) => Promise<void>,
  autoCompact?: AutoCompactSettings,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cp-ctx-window-"));
  let conn: WindowConnection | undefined;
  const cp = new ControlPlane(config(root, autoCompact), {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 0,
    connectionFactory: (opts) => {
      conn = new WindowConnection(opts);
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

function compactStarted(events: any[]): boolean {
  return events.some((e) => e.kind === "compact_started");
}

test("known 1M model: early under-reported 200K size does not compact (table is authoritative)", async () => {
  await withControlPlane(async (cp, conn, events) => {
    conn.opts.onAvailableCommands?.(["compact", "init"]);
    // claude-agent-acp's early frame: heavy used, but the harness still reports the 200K default.
    conn.opts.onContextUsage?.({ used: 230331, size: 200000, percent: 230331 / 200000 });
    await tick();

    const usage = cp.getAgentContextUsage("router");
    expect(usage?.size).toBe(1_000_000); // denominator from the table, not the harness
    expect(usage?.percent).toBeCloseTo(0.23, 2);
    expect(compactStarted(events)).toBe(false);
    // The normalized event mirrors the table denominator.
    const usageEvent = events.filter((e) => e.kind === "agent_usage").at(-1);
    expect(usageEvent).toMatchObject({ agent: "router", size: 1_000_000, used: 230331 });
  });
});

test("known 1M model: real 90% usage compacts even when the harness reports 200K", async () => {
  await withControlPlane(async (cp, conn, events) => {
    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 910000, size: 200000, percent: 910000 / 200000 });
    await tick();

    expect(cp.getAgentContextUsage("router")?.size).toBe(1_000_000);
    expect(cp.getAgentContextUsage("router")?.percent).toBeCloseTo(0.91, 2);
    expect(conn.prompts.map((p) => p.text)).toEqual(["/compact"]);
    expect(compactStarted(events)).toBe(true);
  });
});

test("known 200K model (Opus 4.1) still compacts over threshold", async () => {
  await withControlPlane(async (cp, conn, events) => {
    conn.opts.onAvailableCommands?.(["compact"]);
    await cp.setModel("router", "claude-opus-4-1");
    conn.opts.onContextUsage?.({ used: 190000, size: 200000, percent: 0.95 });
    await tick();

    expect(cp.getAgentContextUsage("router")?.size).toBe(200000);
    expect(compactStarted(events)).toBe(true);
  });
});

test("model switch from 1M to 200K does not leak the 1M denominator", async () => {
  await withControlPlane(async (cp, conn, events) => {
    conn.opts.onAvailableCommands?.(["compact"]);
    // Establish the 1M window on Opus 4.8.
    conn.opts.onContextUsage?.({ used: 100000, size: 200000, percent: 0.5 });
    await tick();
    expect(cp.getAgentContextUsage("router")?.size).toBe(1_000_000);

    // Switch to a 200K model; a subsequent frame must adopt the 200K window, not keep 1M.
    await cp.setModel("router", "claude-opus-4-1");
    conn.opts.onContextUsage?.({ used: 190000, size: 200000, percent: 0.95 });
    await tick();

    expect(cp.getAgentContextUsage("router")?.size).toBe(200000);
    expect(cp.getAgentContextUsage("router")?.percent).toBeCloseTo(0.95, 2);
    expect(compactStarted(events)).toBe(true); // 95% of the real 200K window
  });
});

test("model switch to an unknown model drops the sticky 1M and uses the reported size", async () => {
  await withControlPlane(async (cp, conn) => {
    conn.opts.onContextUsage?.({ used: 100000, size: 200000, percent: 0.5 });
    await tick();
    expect(cp.getAgentContextUsage("router")?.size).toBe(1_000_000);

    await cp.setModel("router", "mystery-model");
    conn.opts.onContextUsage?.({ used: 50000, size: 250000, percent: 0.2 });
    await tick();
    expect(cp.getAgentContextUsage("router")?.size).toBe(250000); // reported, not the prior 1M
  });
});

test("unknown model keeps the window monotonic across frames", async () => {
  await withControlPlane(async (cp, conn) => {
    await cp.setModel("router", "mystery-model");
    conn.opts.onContextUsage?.({ used: 10000, size: 200000, percent: 0.05 });
    await tick();
    expect(cp.getAgentContextUsage("router")?.size).toBe(200000);

    conn.opts.onContextUsage?.({ used: 20000, size: 1_000_000, percent: 0.02 });
    await tick();
    expect(cp.getAgentContextUsage("router")?.size).toBe(1_000_000);

    // A later, smaller frame must not shrink the established window.
    conn.opts.onContextUsage?.({ used: 30000, size: 200000, percent: 0.15 });
    await tick();
    expect(cp.getAgentContextUsage("router")?.size).toBe(1_000_000);
  });
});

test("snapshotEvents replays the normalized usage so reattach restores the chip", async () => {
  await withControlPlane(async (cp, conn) => {
    conn.opts.onAvailableCommands?.(["compact"]);
    conn.opts.onContextUsage?.({ used: 230331, size: 200000, percent: 1.15 });
    await tick();

    const snap = (cp as any).snapshotEvents() as any[];
    const usageEvent = snap.find((e) => e.kind === "agent_usage" && e.agent === "router");
    expect(usageEvent).toMatchObject({ size: 1_000_000, used: 230331 });
    expect(typeof usageEvent.ts).toBe("string");
  });
});

test("force respawn clears the sticky window so it recomputes fresh", async () => {
  await withControlPlane(async (cp, conn) => {
    conn.opts.onContextUsage?.({ used: 100000, size: 200000, percent: 0.5 });
    await tick();
    expect(cp.getAgentContextUsage("router")?.size).toBe(1_000_000);

    await cp.respawnAgent("router", "force");
    expect(cp.getAgentContextUsage("router")).toBeNull();
  });
});

// ── [1m]-aliased config model (context-window-1m-resolve) ─────────────────────
/** Run a plane whose router has `agentModel` configured and whose session returns `session`. */
async function withAgentModel(
  agentModel: string,
  session: unknown,
  fn: (cp: ControlPlane, conn: WindowConnection) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cp-ctx-alias-"));
  let conn: WindowConnection | undefined;
  const cfg: MeshConfig = {
    name: "ctx-window",
    agents: [{ id: "router", harness: "codex", project: root, role: "router", model: agentModel }],
    edges: [],
  };
  const cp = new ControlPlane(cfg, {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 0,
    connectionFactory: (opts) => {
      conn = new (class extends WindowConnection {
        async newSession(): Promise<unknown> { return session; }
      })(opts);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await cp.start();
    if (!conn) throw new Error("connection missing");
    await fn(cp, conn);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("config model 'sonnet[1m]' with NO advertised models normalizes to the 1M window", async () => {
  // Session advertises no models -> sessionModels stays empty -> the configured alias is used.
  await withAgentModel("sonnet[1m]", { sessionId: "s-router" }, async (cp, conn) => {
    conn.opts.onContextUsage?.({ used: 100000, size: 200000, percent: 0.5 });
    await tick();
    expect(cp.getAgentContextUsage("router")?.size).toBe(1_000_000);
    expect(cp.getAgentContextUsage("router")?.percent).toBeCloseTo(0.1, 2);
  });
});

test("advertised 'default' shadowing config 'sonnet[1m]' still resolves 1M via config fallback", async () => {
  const session = {
    sessionId: "s-router",
    models: { currentModelId: "default", availableModels: [{ modelId: "default", name: "Default" }] },
  };
  await withAgentModel("sonnet[1m]", session, async (cp, conn) => {
    conn.opts.onContextUsage?.({ used: 100000, size: 200000, percent: 0.5 });
    await tick();
    // advertised "default" → unknown window; falls back to the configured sonnet[1m] → 1M.
    expect(cp.getAgentContextUsage("router")?.size).toBe(1_000_000);
  });
});
