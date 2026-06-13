import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";

class RespawnConnection {
  kills = 0;
  prompts: string[] = [];
  releasePrompt?: () => void;
  constructor(readonly opts: AcpConnectionOptions, private holdPrompt = false) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> { return { agentInfo: { version: "1.0.0" } }; }
  async newSession(): Promise<unknown> { return { sessionId: `s-${this.opts.id}-${Math.random()}` }; }
  async prompt(text: string): Promise<unknown> {
    this.prompts.push(text);
    if (!this.holdPrompt) return { stopReason: "end_turn" };
    await new Promise<void>((resolve) => { this.releasePrompt = resolve; });
    return { stopReason: "end_turn" };
  }
  async steerPrompt(text: string): Promise<unknown> { return this.prompt(text); }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void { this.kills++; }
}

function config(root: string): MeshConfig {
  return { name: "respawn", agents: [{ id: "router", harness: "codex", project: root, role: "router" }], edges: [] };
}

test("respawnAgent force kills current process and spawns fresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-respawn-force-"));
  const created: RespawnConnection[] = [];
  const cp = new ControlPlane(config(root), {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = new RespawnConnection(opts);
      created.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    const res = await cp.respawnAgent("router", "force");
    expect(res).toMatchObject({ mode: "force", scheduled: false, willRunWhen: "now", note: "ACP session context will be lost; mailbox preserved" });
    expect(created).toHaveLength(2);
    expect(created[0].kills).toBeGreaterThan(0);
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "router", detail: "agent respawned (force)" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("respawnAgent after-idle schedules while working and cancel clears pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-respawn-after-idle-"));
  const created: RespawnConnection[] = [];
  const cp = new ControlPlane(config(root), {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = new RespawnConnection(opts, created.length === 0);
      created.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await cp.start();
    const prompt = cp.prompt("router", "hold");
    await Bun.sleep(0);
    const scheduled = await cp.respawnAgent("router", "after-idle");
    expect(scheduled).toMatchObject({ mode: "after-idle", scheduled: true, willRunWhen: "idle" });
    const canceled = await cp.respawnAgent("router", "cancel");
    expect(canceled).toMatchObject({ mode: "cancel", scheduled: false });
    created[0].releasePrompt?.();
    await prompt;
    await Bun.sleep(0);
    expect(created).toHaveLength(1);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
