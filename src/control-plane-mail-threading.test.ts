// Mail threading + anti-polling surfaces: short #seq numbers, reply_to quoting,
// task tagging, the empty-poll nudge, and the mesh_briefing recall tool.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { readMailboxEvents } from "./mailbox";

const config: MeshConfig = {
  name: "mail-threading",
  agents: [
    { id: "router", harness: "claude", project: ".", role: "router" },
    { id: "member", harness: "codex", project: ".", role: "member" },
  ],
  edges: [
    { from: "router", to: "member" },
    { from: "member", to: "router" },
  ],
};

class FakeConnection {
  supportsLoadSession = false;
  prompts: string[] = [];
  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return { agentCapabilities: { promptCapabilities: { image: false } } };
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `s-${this.opts.id}` };
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

function makePlane(root: string, conns: Record<string, FakeConnection>) {
  return new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    connectionFactory: (opts) => {
      const conn = new FakeConnection(opts);
      conns[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });
}

const waitUntil = async (cond: () => boolean, ms = 2_000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("send_mail assigns #seq, reply_to renders header and quote, task tags the thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-threading-"));
  const conns: Record<string, FakeConnection> = {};
  const cp = makePlane(root, conns);
  try {
    await cp.start();
    const first = await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "[REQ] which port?");
    expect(first).toBe("queued for member as #1; wake scheduled");

    const reply = await (cp as any).handleSendMail(
      { agentId: "member", role: "member" },
      "router",
      "[FYI] port 15001",
      { replyTo: 1, task: "fix-ports" },
    );
    expect(reply).toBe("queued for router as #2; wake scheduled");

    await waitUntil(() => conns["router"].prompts.some((p) => p.includes("#2")));
    const delivered = conns["router"].prompts.find((p) => p.includes("#2"))!;
    expect(delivered).toContain("[MAIL #2 from member | task: fix-ports | in reply to #1]: [FYI] port 15001");
    expect(delivered).toContain('(#1, router → member, was: "[REQ] which port?")');

    // The durable event carries the threading metadata.
    const events = await readMailboxEvents(join(root, "mailbox.ndjson"));
    const ev = events.find((e) => (e.meta as any)?.seq === 2)!;
    expect(ev.taskId).toBe("fix-ports");
    expect((ev.meta as any).replyTo).toBe(1);

    // check_mail renders the same header + quote.
    const checked = await (cp as any).handleCheckMail({ agentId: "router", role: "router" });
    expect(checked).toContain("[MAIL #2 from member | task: fix-ports | in reply to #1]: [FYI] port 15001");
    expect(checked).toContain('(#1, router → member, was: "[REQ] which port?")');
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("reply_to referencing unknown mail still delivers but notes the bad reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-threading-badref-"));
  const conns: Record<string, FakeConnection> = {};
  const cp = makePlane(root, conns);
  try {
    await cp.start();
    const res = await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "hi", { replyTo: 99 });
    expect(res).toContain("queued for member as #1; wake scheduled");
    expect(res).toContain("reply_to #99 does not match any known mail");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated empty check_mail calls get a stop-polling reminder; fresh mail resets it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-threading-poll-"));
  const conns: Record<string, FakeConnection> = {};
  const cp = makePlane(root, conns);
  try {
    await cp.start();
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("no new mail");
    const second = await (cp as any).handleCheckMail({ agentId: "member", role: "member" });
    expect(second).toContain("no new mail");
    expect(second).toContain("end your turn");

    // Real mail arriving resets the streak: the next single empty check is quiet again.
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "member", "work");
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toContain("[MAIL #1 from router]: work");
    expect(await (cp as any).handleCheckMail({ agentId: "member", role: "member" })).toBe("no new mail");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("mesh_briefing returns the live briefing with a generated banner; unknown agent errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-threading-brief-"));
  const conns: Record<string, FakeConnection> = {};
  const cp = makePlane(root, conns);
  try {
    await cp.start();
    const briefing = (cp as any).meshBriefingText("member");
    expect(briefing).toContain("from the live mesh configuration");
    expect(briefing).toContain('You are "member"');
    expect(briefing).toContain("Mesh communication rules (MUST follow):");
    expect((cp as any).meshBriefingText("nobody")).toContain('error: no agent "nobody"');
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("mail seq survives a daemon restart and keeps increasing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-mail-threading-restart-"));
  const conns: Record<string, FakeConnection> = {};
  try {
    const first = makePlane(root, conns);
    await first.start();
    await (first as any).handleSendMail({ agentId: "router", role: "router" }, "member", "one");
    await (first as any).handleSendMail({ agentId: "router", role: "router" }, "member", "two");
    await first.stop();

    const second = makePlane(root, conns);
    await second.start();
    const res = await (second as any).handleSendMail({ agentId: "router", role: "router" }, "member", "three");
    expect(res).toBe("queued for member as #3; wake scheduled");
    // The reply quote map is also recovered: replying to #2 renders its quote.
    const reply = await (second as any).handleSendMail({ agentId: "member", role: "member" }, "router", "re", { replyTo: 2 });
    expect(reply).toBe("queued for router as #4; wake scheduled");
    await waitUntil(() => conns["router"].prompts.some((p) => p.includes("#4")));
    const delivered = conns["router"].prompts.find((p) => p.includes("#4"))!;
    expect(delivered).toContain('(#2, router → member, was: "two")');
    await second.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
