import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";

class UsageTrackingConnection {
  kills = 0;

  constructor(readonly opts: AcpConnectionOptions) {}

  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `s-${this.opts.id}-${Math.random()}` };
  }
  async prompt(): Promise<unknown> {
    return { stopReason: "end_turn" };
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {
    this.kills++;
  }
}

function config(root: string): MeshConfig {
  return { name: "usage-tracking", agents: [{ id: "router", harness: "codex", project: root, role: "router" }], edges: [] };
}

async function withControlPlane(fn: (cp: ControlPlane, created: UsageTrackingConnection[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cp-usage-tracking-"));
  const created: UsageTrackingConnection[] = [];
  const cp = new ControlPlane(config(root), {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = new UsageTrackingConnection(opts);
      created.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await cp.start();
    await fn(cp, created);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("ControlPlane tracks per-agent context usage callbacks", async () => {
  await withControlPlane(async (cp, created) => {
    created[0].opts.onContextUsage?.({ used: 100, size: 1000, percent: 0.1 });

    expect(cp.getAgentContextUsage("router")).toMatchObject({ used: 100, size: 1000, percent: 0.1 });
    expect(cp.getAgentContextUsage("router")?.updatedAt).toBeGreaterThan(0);
    expect(cp.listAgentContextUsages().get("router")?.percent).toBe(0.1);
  });
});

test("ControlPlane tracks normalized advertised commands callbacks", async () => {
  await withControlPlane(async (cp, created) => {
    created[0].opts.onAvailableCommands?.(["compact", "init"]);

    expect(cp.getAgentAdvertisedCommands("router")).toEqual(new Set(["compact", "init"]));
  });
});

test("ControlPlane clears usage and commands on fresh spawn", async () => {
  await withControlPlane(async (cp, created) => {
    created[0].opts.onContextUsage?.({ used: 100, size: 1000, percent: 0.1 });
    created[0].opts.onAvailableCommands?.(["compact", "init"]);

    await cp.respawnAgent("router", "force");

    expect(cp.getAgentContextUsage("router")).toBeNull();
    expect(cp.getAgentAdvertisedCommands("router")).toEqual(new Set());
  });
});

test("ControlPlane clears usage and commands on stopAgent", async () => {
  await withControlPlane(async (cp, created) => {
    created[0].opts.onContextUsage?.({ used: 100, size: 1000, percent: 0.1 });
    created[0].opts.onAvailableCommands?.(["compact", "init"]);

    await cp.stopAgent("router");

    expect(cp.getAgentContextUsage("router")).toBeNull();
    expect(cp.getAgentAdvertisedCommands("router")).toEqual(new Set());
  });
});

test("ControlPlane clears usage and commands on force respawn", async () => {
  await withControlPlane(async (cp, created) => {
    created[0].opts.onContextUsage?.({ used: 100, size: 1000, percent: 0.1 });
    created[0].opts.onAvailableCommands?.(["compact", "init"]);

    await cp.respawnAgent("router", "force");

    expect(cp.getAgentContextUsage("router")).toBeNull();
    expect(cp.getAgentAdvertisedCommands("router")).toEqual(new Set());
  });
});
