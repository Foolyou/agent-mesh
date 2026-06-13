import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { AgentTurn, MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";

class BarePromptConnection {
  prompts: Array<{ text: string; turn?: AgentTurn }> = [];
  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `s-${this.opts.id}` };
  }
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

function config(root: string): MeshConfig {
  return { name: "bare-prompt", agents: [{ id: "router", harness: "codex", project: root, role: "router" }], edges: [] };
}

async function withControlPlane(fn: (cp: ControlPlane, conn: BarePromptConnection, root: string, events: any[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cp-bare-prompt-"));
  let conn: BarePromptConnection | undefined;
  const cp = new ControlPlane(config(root), {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 0,
    connectionFactory: (opts) => {
      conn = new BarePromptConnection(opts);
      return conn as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    if (!conn) throw new Error("connection missing");
    await fn(cp, conn, root, events);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("sendBarePrompt sends verbatim text without mail wrapping or mailbox history", async () => {
  await withControlPlane(async (cp, conn, root, events) => {
    await cp.sendBarePrompt("router", "/compact", { reason: "auto-threshold" });

    expect(conn.prompts).toHaveLength(1);
    expect(conn.prompts[0].text).toBe("/compact");
    expect(conn.prompts[0].text).not.toContain("[MAIL #");
    expect(conn.prompts[0].turn).toMatchObject({
      agent: "router",
      source: "system",
      text: "/compact",
      preview: "system: auto-threshold",
    });
    await expect(readFile(join(root, "mailbox.ndjson"), "utf8")).rejects.toThrow();
    expect((cp as any).turnOutboundMailCount.get(conn.prompts[0].turn!.id)).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      kind: "bare_prompt",
      agent: "router",
      reason: "auto-threshold",
    }));
  });
});

test("sendBarePrompt rejects stopped or dead agents", async () => {
  await withControlPlane(async (cp) => {
    await cp.stopAgent("router");
    await expect(cp.sendBarePrompt("router", "/compact")).rejects.toThrow(/stopped|dead|no connection/i);
  });
});
