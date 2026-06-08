// src/control-plane-setmode.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { DEMO_MESH } from "./config";

class FakeAcpConnection {
  constructor(private opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return { agentCapabilities: { promptCapabilities: { image: true } } };
  }
  async newSession(): Promise<unknown> {
    return {
      sessionId: `s-${this.opts.id}`,
      promptCapabilities: { image: false },
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default", description: "normal access" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
  }
  async prompt(): Promise<unknown> {
    return { stopReason: "end_turn" };
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {}
}

class ConfigOptionsConnection {
  setModes: string[] = [];
  setModels: string[] = [];

  constructor(private opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return {
      sessionId: `s-${this.opts.id}`,
      configOptions: [
        {
          category: "mode",
          currentValue: "build",
          options: [
            { value: "build", name: "Build", description: "can edit" },
            { value: "plan", name: "Plan", description: "read-only planning" },
          ],
        },
        {
          category: "model",
          currentValue: "kimi-k2",
          options: [
            { value: "kimi-k2", name: "kimi-k2" },
            { value: "deepseek-v3", name: "deepseek-v3" },
          ],
        },
      ],
    };
  }
  async prompt(): Promise<unknown> {
    return { stopReason: "end_turn" };
  }
  async setMode(modeId: string): Promise<void> {
    this.setModes.push(modeId);
  }
  async setModel(modelId: string): Promise<void> {
    this.setModels.push(modelId);
  }
  async cancel(): Promise<void> {}
  kill(): void {}
}

class DeferredPromptConnection {
  prompts: Array<{ text: string; resolve: (value?: unknown) => void; reject: (err: unknown) => void }> = [];

  prompt(text: string): Promise<unknown> {
    return new Promise((resolve, reject) => this.prompts.push({ text, resolve, reject }));
  }
}

class StartableDeferredConnection extends DeferredPromptConnection {
  constructor(readonly opts: any) {
    super();
  }
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return {};
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {}
}

test("setMode throws for an unknown agent (no connection)", async () => {
  const cp = new ControlPlane(DEMO_MESH);
  await expect(cp.setMode("ghost", "read-only")).rejects.toThrow(/no connection/);
});

test("setModel throws for an unknown agent (no connection)", async () => {
  const cp = new ControlPlane(DEMO_MESH);
  await expect(cp.setModel("ghost", "kimi-k2")).rejects.toThrow(/no connection/);
});

test("prompt injects the mesh briefing exactly once per agent", () => {
  const cp = new ControlPlane(DEMO_MESH);
  const seen: string[] = [];
  const fake = { prompt: (t: string) => (seen.push(t), Promise.resolve({})) };
  (cp as any).conns.set("router", fake);
  cp.prompt("router", "do the thing");
  cp.prompt("router", "again");
  expect(seen[0]).toContain("[MESH BRIEFING]");
  expect(seen[0]).toContain("do the thing");
  expect(seen[1]).toBe("again"); // briefing not repeated
});

test("prompt emits working during a turn and idle after it settles", async () => {
  const cp = new ControlPlane(DEMO_MESH);
  const fake = new DeferredPromptConnection();
  (cp as any).conns.set("router", fake);
  (cp as any).mesh.setStatus("router", "ready");
  const events: any[] = [];
  cp.on((e) => events.push(e));

  const p = cp.prompt("router", "do the thing");

  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "router", activity: "working" }));
  expect((cp as any).meshStatusText("router")).toContain("- router (you) [claude, router, ready, working]");
  fake.prompts[0].resolve({});
  await p;

  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "router", activity: "idle" }));
  expect((cp as any).meshStatusText("router")).toContain("- router (you) [claude, router, ready, idle]");
});

test("concurrent prompt turns stay working until all turns settle", async () => {
  const cp = new ControlPlane(DEMO_MESH);
  const fake = new DeferredPromptConnection();
  (cp as any).conns.set("router", fake);
  (cp as any).mesh.setStatus("router", "ready");
  const events: any[] = [];
  cp.on((e) => events.push(e));

  const p1 = cp.prompt("router", "one");
  const p2 = cp.prompt("router", "two");
  fake.prompts[0].resolve({});
  await p1;

  expect((cp as any).meshStatusText("router")).toContain("- router (you) [claude, router, ready, working]");
  expect(events.filter((e) => e.kind === "agent_activity" && e.agent === "router" && e.activity === "idle")).toHaveLength(0);

  fake.prompts[1].resolve({});
  await p2;

  expect((cp as any).meshStatusText("router")).toContain("- router (you) [claude, router, ready, idle]");
  expect(events.filter((e) => e.kind === "agent_activity" && e.agent === "router" && e.activity === "working")).toHaveLength(1);
  expect(events.filter((e) => e.kind === "agent_activity" && e.agent === "router" && e.activity === "idle")).toHaveLength(1);
});

test("mail wake emits working while the recipient handles the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-wake-"));
  const cp = new ControlPlane(DEMO_MESH, { mailboxPath: join(root, "mailbox.ndjson") });
  const fake = new DeferredPromptConnection();
  (cp as any).conns.set("codex-1", fake);
  (cp as any).mesh.setStatus("codex-1", "ready");
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await (cp as any).handleSendMail({ agentId: "router", role: "router" }, "codex-1", "ping");

    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "codex-1", activity: "working" }));
    expect((cp as any).meshStatusText("router")).toContain("- codex-1 [codex, member, ready, working]");

    fake.prompts[0].resolve({});
    await Promise.resolve();

    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "codex-1", activity: "idle" }));
    expect((cp as any).meshStatusText("router")).toContain("- codex-1 [codex, member, ready, idle]");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dead agents are reported idle even with an in-flight turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-activity-"));
  const config: MeshConfig = {
    name: "activity",
    agents: [{ id: "router", harness: "claude", project: ".", role: "router" }],
    edges: [],
  };
  let conn: StartableDeferredConnection | undefined;
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      conn = new StartableDeferredConnection(opts);
      return conn as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    const p = cp.prompt("router", "work");
    conn?.opts.onExit(1);

    expect((cp as any).meshStatusText("router")).toContain("- router (you) [claude, router, dead, idle]");
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "router", activity: "idle" }));

    conn!.prompts[0].resolve({});
    await p;
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("meshStatusText includes activity for every agent", () => {
  const cp = new ControlPlane(DEMO_MESH);
  expect((cp as any).meshStatusText("codex-1")).toContain("[codex, member, spawning, idle]");
});

test("start emits image capability advertised by initialize", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-cap-"));
  const config: MeshConfig = {
    name: "cap",
    agents: [{ id: "router", harness: "claude", project: ".", role: "router" }],
    edges: [],
  };
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => new FakeAcpConnection(opts) as unknown as AcpAgentConnection,
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    const cap = events.find((e) => e.kind === "agent_capabilities" && e.agent === "router");
    expect(cap?.image).toBe(true);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshotEvents backfills current status, activity, capabilities, and modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-snapshot-"));
  const config: MeshConfig = {
    name: "snapshot",
    agents: [{ id: "router", harness: "claude", project: ".", role: "router" }],
    edges: [],
  };
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => new FakeAcpConnection(opts) as unknown as AcpAgentConnection,
  });
  try {
    await cp.start();
    const events = cp.snapshotEvents();
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "router", status: "ready" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "router", activity: "idle" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_capabilities", agent: "router", image: true }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "agent_modes",
      agent: "router",
      current: "default",
      available: [
        { id: "default", name: "Default", description: "normal access" },
        { id: "plan", name: "Plan", description: undefined },
      ],
    }));

    (cp as any).mesh.setStatus("router", "dead");
    expect(cp.snapshotEvents()).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "router", status: "dead" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("start derives modes and models from configOptions when availableModes are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-config-options-"));
  const config: MeshConfig = {
    name: "config-options",
    agents: [{ id: "router", harness: "opencode", project: ".", role: "router", mode: "plan", model: "deepseek-v3" }],
    edges: [],
  };
  let conn: ConfigOptionsConnection | undefined;
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      conn = new ConfigOptionsConnection(opts);
      return conn as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    await cp.start();
    expect(events).toContainEqual(expect.objectContaining({
      kind: "agent_modes",
      agent: "router",
      current: "plan",
      available: [
        { id: "build", name: "Build", description: "can edit" },
        { id: "plan", name: "Plan", description: "read-only planning" },
      ],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "agent_models",
      agent: "router",
      current: "deepseek-v3",
      available: [
        { id: "kimi-k2", name: "kimi-k2" },
        { id: "deepseek-v3", name: "deepseek-v3" },
      ],
    }));
    expect(conn?.setModes).toEqual(["plan"]);
    expect(conn?.setModels).toEqual(["deepseek-v3"]);
    expect(cp.snapshotEvents()).toContainEqual(expect.objectContaining({ kind: "agent_models", agent: "router", current: "deepseek-v3" }));

    await cp.setModel("router", "kimi-k2");
    expect(conn?.setModels).toEqual(["deepseek-v3", "kimi-k2"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_models", agent: "router", current: "kimi-k2" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
