import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { readSessionState } from "./session-storage";

const config: MeshConfig = {
  name: "mail-cursor",
  agents: [
    { id: "router", harness: "claude", project: ".", role: "router" },
    { id: "member", harness: "codex", project: ".", role: "member" },
  ],
  edges: [
    { from: "router", to: "member" },
    { from: "member", to: "router" },
  ],
};

class CursorConnection {
  supportsLoadSession = true;
  prompts: string[] = [];
  newSessionCount = 0;
  loadCalls: string[] = [];

  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return { agentCapabilities: { loadSession: true, promptCapabilities: { image: false } } };
  }
  async newSession(): Promise<unknown> {
    this.newSessionCount++;
    return { sessionId: `s-${this.opts.id}-${this.newSessionCount}` };
  }
  async loadSession(sessionId: string): Promise<unknown> {
    this.loadCalls.push(sessionId);
    return { sessionId };
  }
  async prompt(text: string): Promise<unknown> {
    this.prompts.push(text);
    return {};
  }
  async steerPrompt(text: string): Promise<unknown> {
    return this.prompt(text);
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {}
}

test("check_mail persists a recipient cursor and cold restart returns only later mail", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-cursor-"));
  const mailboxPath = join(root, "mailbox.ndjson");
  const runDir = join(root, "run");
  const created: CursorConnection[] = [];

  const makePlane = () =>
    new ControlPlane(config, {
      mailboxPath,
      sessionRunDir: runDir,
      connectionFactory: (opts) => {
        const conn = new CursorConnection(opts);
        created.push(conn);
        return conn as unknown as AcpAgentConnection;
      },
    });

  try {
    const first = makePlane();
    await first.start();
    await (first as any).handleSendMail({ agentId: "router", role: "router" }, "member", "old");
    expect(await (first as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("from router: old");
    const stored = await readSessionState(runDir, config.name);
    expect(stored.agents.member.mailCursor).toBeString();
    await first.stop();

    const second = makePlane();
    await second.start();
    await (second as any).handleSendMail({ agentId: "router", role: "router" }, "member", "new");
    expect(await (second as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("from router: new");
    await second.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newSession preserves the mail cursor so read mail is not delivered again", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-new-session-"));
  const mailboxPath = join(root, "mailbox.ndjson");
  const runDir = join(root, "run");
  const cp = new ControlPlane(config, {
    mailboxPath,
    sessionRunDir: runDir,
    connectionFactory: (opts) => new CursorConnection(opts) as unknown as AcpAgentConnection,
  });

  try {
    await cp.start();
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "old");
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("from router: old");
    expect((await readSessionState(runDir, config.name)).agents.member.mailCursor).toBeString();

    await cp.newSession("member");

    expect((await readSessionState(runDir, config.name)).agents.member.mailCursor).toBeString();
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("no new mail");
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "new");
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("from router: new");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
