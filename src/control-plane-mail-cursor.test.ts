import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { readSessionState } from "./session-storage";
import { readMailboxEvents, sendMail } from "./mailbox";

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
  removeQueued(): unknown[] {
    return [];
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
    expect(await (first as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("[MAIL #1 from router]: old");
    const stored = await readSessionState(runDir, config.name);
    expect(stored.agents.member.mailCursor).toBeString();
    await first.stop();

    const second = makePlane();
    await second.start();
    await (second as any).handleSendMail({ agentId: "router", role: "router" }, "member", "new");
    expect(await (second as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("[MAIL #2 from router]: new");
    await second.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshotEvents replays recent durable mail (with stable ids) across a control-plane restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-snapshot-"));
  const mailboxPath = join(root, "mailbox.ndjson");
  const runDir = join(root, "run");
  const makePlane = () =>
    new ControlPlane(config, {
      mailboxPath,
      sessionRunDir: runDir,
      connectionFactory: (opts) => new CursorConnection(opts) as unknown as AcpAgentConnection,
    });

  try {
    const first = makePlane();
    const liveEvents: any[] = [];
    first.on((e) => liveEvents.push(e));
    await first.start();
    await (first as any).handleSendMail({ agentId: "router", role: "router" }, "member", "hello there");
    const liveMail = liveEvents.find((e) => e.kind === "mail");
    expect(liveMail.id).toBeString();
    expect(first.snapshotEvents()).toContainEqual(
      expect.objectContaining({ kind: "mail", id: liveMail.id, from: "router", to: "member", body: "hello there" }),
    );
    await first.stop();

    const second = makePlane();
    await second.start();
    expect(second.snapshotEvents()).toContainEqual(
      expect.objectContaining({ kind: "mail", id: liveMail.id, from: "router", to: "member", body: "hello there" }),
    );
    await second.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start snapshot replays only unread durable mail after each recipient cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-start-unread-"));
  const mailboxPath = join(root, "mailbox.ndjson");
  const runDir = join(root, "run");
  const makePlane = () =>
    new ControlPlane(config, {
      mailboxPath,
      sessionRunDir: runDir,
      connectionFactory: (opts) => new CursorConnection(opts) as unknown as AcpAgentConnection,
    });

  try {
    const first = makePlane();
    await first.start();
    await (first as any).handleSendMail({ agentId: "router", role: "router" }, "member", "already read");
    expect(await (first as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("[MAIL #1 from router]: already read");
    await first.stop();

    const unread = await sendMail({ mailboxPath, mesh: config.name, from: "router", to: "member", body: "still unread" });

    const second = makePlane();
    await second.start();
    const mail = second.snapshotEvents().filter((event) => event.kind === "mail");
    expect(mail).toEqual([
      expect.objectContaining({ kind: "mail", id: unread.id, from: "router", to: "member", body: "still unread" }),
    ]);
    await second.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop compacts consumed mail so the next start does not scan handled history", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-stop-compact-"));
  const mailboxPath = join(root, "mailbox.ndjson");
  const runDir = join(root, "run");
  const cp = new ControlPlane(config, {
    mailboxPath,
    sessionRunDir: runDir,
    connectionFactory: (opts) => new CursorConnection(opts) as unknown as AcpAgentConnection,
  });

  try {
    await cp.start();
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "handled");
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("[MAIL #1 from router]: handled");
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "pending");

    await cp.stop();

    expect((await readMailboxEvents(mailboxPath)).map((event) => event.body)).toEqual(["pending"]);
    expect((await readMailboxEvents(mailboxPath.replace(/\.ndjson$/, ".archive.ndjson"))).map((event) => event.body)).toEqual(["handled"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check_mail caps a batch by count, advances cursor only past returned mail, and reports the remainder", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-batch-count-"));
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    checkMailMaxCount: 2,
    connectionFactory: (opts) => new CursorConnection(opts) as unknown as AcpAgentConnection,
  });

  try {
    await cp.start();
    for (const body of ["one", "two", "three"]) {
      await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", body);
    }
    const first = await (cp as any).handleCheckMail({ agentId: "member", role: "member" });
    expect(first).toContain("[MAIL #1 from router]: one");
    expect(first).toContain("[MAIL #2 from router]: two");
    expect(first).not.toContain("from router]: three");
    expect(first).toContain("1 more message");

    const second = await (cp as any).handleCheckMail({ agentId: "member", role: "member" });
    expect(second).toBe("[MAIL #3 from router]: three");
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("no new mail");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("check_mail caps a batch by bytes but always returns at least one mail", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-batch-bytes-"));
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    checkMailMaxBytes: 64,
    connectionFactory: (opts) => new CursorConnection(opts) as unknown as AcpAgentConnection,
  });

  try {
    await cp.start();
    const big = "x".repeat(100);
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", big);
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "small");

    const first = await (cp as any).handleCheckMail({ agentId: "member", role: "member" });
    expect(first).toContain(big);
    expect(first).not.toContain("from router]: small");
    expect(first).toContain("1 more message");

    const second = await (cp as any).handleCheckMail({ agentId: "member", role: "member" });
    expect(second).toBe("[MAIL #2 from router]: small");
  } finally {
    await cp.stop();
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
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("[MAIL #1 from router]: old");
    expect((await readSessionState(runDir, config.name)).agents.member.mailCursor).toBeString();

    await cp.newSession("member");

    expect((await readSessionState(runDir, config.name)).agents.member.mailCursor).toBeString();
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("no new mail");
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "new");
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("[MAIL #2 from router]: new");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
