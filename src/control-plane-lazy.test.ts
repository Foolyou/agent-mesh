import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { readMailFor } from "./mailbox";

const lazyConfig: MeshConfig = {
  name: "lazy",
  agents: [
    { id: "router", harness: "claude", project: ".", role: "router" },
    { id: "lazy-1", harness: "codex", project: ".", role: "member", lazy: true },
  ],
  edges: [
    { from: "router", to: "lazy-1" },
    { from: "lazy-1", to: "router" },
  ],
};

class RecordingConnection {
  starts = 0;
  prompts: string[] = [];
  killed = false;

  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {
    this.starts++;
  }
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return {};
  }
  async prompt(text: string): Promise<unknown> {
    this.prompts.push(text);
    return {};
  }
  async steerPrompt(text: string): Promise<unknown> {
    this.prompts.push(text);
    return {};
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {
    this.killed = true;
  }
}

class DeferredStartConnection extends RecordingConnection {
  startResolve!: () => void;
  startReject!: (err: unknown) => void;
  startPromise = new Promise<void>((resolve, reject) => {
    this.startResolve = resolve;
    this.startReject = reject;
  });
  override async start(): Promise<void> {
    this.starts++;
    await this.startPromise;
  }
}

class FailingStartConnection extends RecordingConnection {
  override async start(): Promise<void> {
    this.starts++;
    throw new Error("boom");
  }
}

function waitUntil(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("lazy agents start cold without a connection while eager agents become ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-lazy-start-"));
  const created: Record<string, RecordingConnection> = {};
  const cp = new ControlPlane(lazyConfig, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = new RecordingConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    expect(created.router).toBeDefined();
    expect(created["lazy-1"]).toBeUndefined();
    expect((cp as any).mesh.status("router")).toBe("ready");
    expect((cp as any).mesh.status("lazy-1")).toBe("cold");
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "lazy-1", status: "cold" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("first mail to a lazy agent triggers one spawn and one check_mail drain prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-lazy-mail-"));
  const created: Record<string, RecordingConnection> = {};
  const cp = new ControlPlane(lazyConfig, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = new RecordingConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    const res = await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "lazy-1", "hello");
    expect(res).toBe("delivered to lazy-1");
    await waitUntil(() => created["lazy-1"]?.prompts.length === 1);

    expect(created["lazy-1"].starts).toBe(1);
    expect((cp as any).mesh.status("lazy-1")).toBe("ready");
    expect(created["lazy-1"].prompts[0]).toContain("call check_mail");
    expect(created["lazy-1"].prompts[0]).not.toContain("[MAIL from router]: hello");

    const mail = await readMailFor("lazy-1", { mailboxPath: join(root, "mailbox.ndjson") });
    expect(mail.map((m) => m.body)).toEqual(["hello"]);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent first mails share one spawn and drain once", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-lazy-concurrent-"));
  const created: Record<string, DeferredStartConnection> = {};
  let lazyCreations = 0;
  const cp = new ControlPlane(lazyConfig, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = opts.id === "lazy-1" ? new DeferredStartConnection(opts) : new RecordingConnection(opts);
      if (opts.id === "lazy-1") lazyCreations++;
      created[opts.id] = conn as DeferredStartConnection;
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    await Promise.all([
      (cp as any).handleSendMail({ agentId: "router", role: "router" }, "lazy-1", "one"),
      (cp as any).handleSendMail({ agentId: "router", role: "router" }, "lazy-1", "two"),
    ]);
    await waitUntil(() => lazyCreations === 1);
    created["lazy-1"].startResolve();
    await waitUntil(() => created["lazy-1"].prompts.length === 1);

    expect(lazyCreations).toBe(1);
    expect(created["lazy-1"].starts).toBe(1);
    expect(created["lazy-1"].prompts).toHaveLength(1);
    const mail = await readMailFor("lazy-1", { mailboxPath: join(root, "mailbox.ndjson") });
    expect(mail.map((m) => m.body).sort()).toEqual(["one", "two"]);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("disallowed mail does not spawn a lazy target", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-lazy-no-edge-"));
  let lazyCreations = 0;
  const config: MeshConfig = { ...lazyConfig, edges: [] };
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      if (opts.id === "lazy-1") lazyCreations++;
      return new RecordingConnection(opts) as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    const res = await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "lazy-1", "blocked");
    expect(res).toMatch(/not allowed/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lazyCreations).toBe(0);
    expect((cp as any).mesh.status("lazy-1")).toBe("cold");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("spawn failure marks dead and sends an async spawn failed receipt without losing mail", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-lazy-fail-"));
  const created: Record<string, RecordingConnection> = {};
  const cp = new ControlPlane(lazyConfig, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      if (opts.id === "lazy-1") {
        return new FailingStartConnection(opts) as unknown as AcpAgentConnection;
      }
      const conn = new RecordingConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    expect(await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "lazy-1", "please wake")).toBe("delivered to lazy-1");
    await waitUntil(() => created.router.prompts.length === 1);

    expect((cp as any).mesh.status("lazy-1")).toBe("dead");
    expect(created.router.prompts[0]).toContain("[SPAWN FAILED]");
    expect(created.router.prompts[0]).toContain("lazy-1");
    const lazyMail = await readMailFor("lazy-1", { mailboxPath: join(root, "mailbox.ndjson") });
    expect(lazyMail.map((m) => m.body)).toEqual(["please wake"]);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("three automatic spawn failures trip a fuse until manual wake resets it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-lazy-fuse-"));
  let fail = true;
  let lazyCreations = 0;
  const created: Record<string, RecordingConnection> = {};
  const cp = new ControlPlane(lazyConfig, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      if (opts.id === "lazy-1") {
        lazyCreations++;
        if (fail) return new FailingStartConnection(opts) as unknown as AcpAgentConnection;
      }
      const conn = new RecordingConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    for (const body of ["one", "two", "three"]) {
      await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "lazy-1", body);
      await waitUntil(() => created.router.prompts.length > 0);
      created.router.prompts = [];
    }
    expect(lazyCreations).toBe(3);

    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "lazy-1", "four");
    await waitUntil(() => created.router.prompts.length === 1);
    expect(lazyCreations).toBe(3);
    expect(created.router.prompts[0]).toContain("[SPAWN FAILED]");

    fail = false;
    await cp.wakeAgent("lazy-1");
    expect(lazyCreations).toBe(4);
    expect((cp as any).mesh.status("lazy-1")).toBe("ready");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("spawn timeout fails the lazy spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-lazy-timeout-"));
  let lazyConn: DeferredStartConnection | undefined;
  const cp = new ControlPlane(lazyConfig, {
    mailboxPath: join(root, "mailbox.ndjson"),
    spawnTimeoutMs: 10,
    connectionFactory: (opts) => {
      if (opts.id === "lazy-1") {
        lazyConn = new DeferredStartConnection(opts);
        return lazyConn as unknown as AcpAgentConnection;
      }
      return new RecordingConnection(opts) as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    await expect(cp.wakeAgent("lazy-1")).rejects.toThrow(/timed out/i);
    expect((cp as any).mesh.status("lazy-1")).toBe("dead");
    lazyConn!.startResolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((cp as any).mesh.status("lazy-1")).toBe("dead");
    expect((cp as any).conns.has("lazy-1")).toBe(false);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("addEdge mutates the running control plane and send_mail returns a dynamic peer note", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-add-edge-cp-"));
  const config: MeshConfig = {
    name: "add-edge-cp",
    agents: [
      { id: "router", harness: "claude", project: ".", role: "router" },
      { id: "a", harness: "codex", project: ".", role: "member" },
      { id: "b", harness: "codex", project: ".", role: "member" },
    ],
    edges: [{ from: "router", to: "a" }],
  };
  const created: Record<string, RecordingConnection> = {};
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = new RecordingConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    expect((cp as any).mesh.canMail("a", "b")).toBe(false);
    cp.addEdge({ from: "a", to: "b" });
    expect((cp as any).mesh.canMail("a", "b")).toBe(true);

    const res = await (cp as any).handleSendMail({ agentId: "a", role: "member" }, "b", "review this");
    expect(res).toContain("delivered to b");
    expect(res).toContain("may have been added after your session started");
    await waitUntil(() => created.b.prompts.length === 1);
    expect(created.b.prompts[0]).toContain("[MAIL from a]: review this");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("control-plane addEdge rejects duplicates, steer-to-router, and dead targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-add-edge-cp-validate-"));
  const config: MeshConfig = {
    name: "add-edge-cp-validate",
    agents: [
      { id: "router", harness: "claude", project: ".", role: "router" },
      { id: "a", harness: "codex", project: ".", role: "member" },
      { id: "b", harness: "codex", project: ".", role: "member" },
    ],
    edges: [{ from: "router", to: "a" }],
  };
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => new RecordingConnection(opts) as unknown as AcpAgentConnection,
  });

  try {
    await cp.start();
    expect(() => cp.addEdge({ from: "router", to: "a" })).toThrow(/already exists/i);
    expect(() => cp.addEdge({ from: "a", to: "router", steer: true })).toThrow(/steer.*router/i);
    (cp as any).mesh.setStatus("b", "dead");
    expect(() => cp.addEdge({ from: "a", to: "b" })).toThrow(/dead/i);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
