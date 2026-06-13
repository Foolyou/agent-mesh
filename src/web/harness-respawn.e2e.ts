import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "../acp/client";
import type { MeshConfig } from "../acp/types";
import { ControlPlane } from "../control-plane";

class MailboxRespawnConnection {
  prompts: string[] = [];
  kills = 0;
  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> { return { agentInfo: { version: "1.0.0" } }; }
  async newSession(): Promise<unknown> { return { sessionId: `s-${this.opts.id}-${Math.random()}` }; }
  async prompt(text: string): Promise<unknown> {
    this.prompts.push(text);
    return { stopReason: "end_turn" };
  }
  async steerPrompt(text: string): Promise<unknown> { return this.prompt(text); }
  removeQueued(): unknown[] { return []; }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void { this.kills++; }
}

test("mailbox preserves all pending mail across force agent respawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-harness-respawn-mailbox-"));
  const config: MeshConfig = {
    name: "respawn-mailbox",
    agents: [
      { id: "a", harness: "codex", project: root, role: "router" },
      { id: "b", harness: "claude", project: root, role: "member" },
    ],
    edges: [{ from: "b", to: "a" }],
  };
  const created: Record<string, MailboxRespawnConnection[]> = {};
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = new MailboxRespawnConnection(opts);
      (created[opts.id] ??= []).push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await cp.start();
    for (const body of ["pre-1", "pre-2", "pre-3"]) {
      await (cp as any).handleSendMail({ agentId: "b", role: "member" }, "a", body);
    }

    await cp.respawnAgent("a", "force");
    expect(created.a).toHaveLength(2);
    expect(created.a[0].kills).toBeGreaterThan(0);

    for (const body of ["post-1", "post-2"]) {
      await (cp as any).handleSendMail({ agentId: "b", role: "member" }, "a", body);
    }

    const inbox = await (cp as any).handleCheckMail({ agentId: "a", role: "router" });
    for (const body of ["pre-1", "pre-2", "pre-3", "post-1", "post-2"]) {
      expect(inbox).toContain(body);
    }
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
