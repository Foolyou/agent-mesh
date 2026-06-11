// src/control-plane-setmode.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, spyOn } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { DEMO_MESH } from "./config";
import { readSessionState, writeSessionState } from "./session-storage";

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

test("image-only operator and steer turns use a readable preview placeholder", () => {
  const cp = new ControlPlane(DEMO_MESH);
  const image = { id: "img-1", mimeType: "image/png", name: "shot.png", url: "/uploads/shot.png" };

  expect((cp as any).operatorTurn("router", "", [image]).preview).toBe("you: [image]");
  expect((cp as any).steerTurn("router", "operator", "", [image]).preview).toBe("you: [image]");
});

class ConfigOptionsConnection {
  setModes: string[] = [];
  setModels: string[] = [];
  setConfigOptions: Array<{ configId: string; value: string }> = [];

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
  async setConfigOption(configId: string, value: string): Promise<void> {
    this.setConfigOptions.push({ configId, value });
  }
  async cancel(): Promise<void> {}
  kill(): void {}
}

class ModelSelectionConnection {
  setModels: string[] = [];

  constructor(
    private opts: AcpConnectionOptions,
    private session: unknown,
  ) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `s-${this.opts.id}`, ...(this.session as any) };
  }
  async prompt(): Promise<unknown> {
    return { stopReason: "end_turn" };
  }
  async setMode(): Promise<void> {}
  async setModel(modelId: string): Promise<void> {
    this.setModels.push(modelId);
  }
  async cancel(): Promise<void> {}
  kill(): void {}
}

function standardModels(currentModelId = "default-model", ids = ["default-model", "preferred-model"]) {
  return {
    models: {
      currentModelId,
      availableModels: ids.map((id) => ({ modelId: id, name: `Model ${id}` })),
    },
  };
}

function configModels(currentValue = "default-config-model", ids = ["default-config-model", "preferred-config-model"]) {
  return {
    configOptions: [
      {
        category: "model",
        currentValue,
        options: ids.map((id) => ({ value: id, name: `Config ${id}` })),
      },
    ],
  };
}

function codexModels(currentModelId = "gpt-5.5/low", bareIds = ["gpt-5.4", "gpt-5.5"]) {
  const efforts = ["low", "medium", "high", "xhigh"];
  return {
    ...standardModels(currentModelId, bareIds.flatMap((id) => efforts.map((effort) => `${id}/${effort}`))),
    ...configModels(bareIds[0], bareIds),
  };
}

async function startOneAgentWithModel({
  harness = "opencode",
  model,
  effort,
  session,
  sessionRunDir,
}: {
  harness?: MeshConfig["agents"][number]["harness"];
  model?: string;
  effort?: MeshConfig["agents"][number]["effort"];
  session: unknown;
  sessionRunDir?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-model-select-"));
  const config: MeshConfig = {
    name: "model-select",
    agents: [{ id: "router", harness, project: root, role: "router", model, effort }],
    edges: [],
  };
  let conn: ModelSelectionConnection | undefined;
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir,
    connectionFactory: (opts) => {
      conn = new ModelSelectionConnection(opts, session);
      return conn as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  await cp.start();
  return { root, cp, conn: conn!, events };
}

function sessionSetup(sessionId: string): unknown {
  return {
    sessionId,
    modes: {
      currentModeId: "build",
      availableModes: [
        { id: "build", name: "Build", description: "can edit" },
        { id: "plan", name: "Plan", description: "read-only planning" },
      ],
    },
    configOptions: [
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

class ResumeConnection {
  supportsLoadSession = false;
  newSessionCount = 0;
  loadCalls: any[] = [];
  prompts: string[] = [];
  setModes: string[] = [];
  setModels: string[] = [];
  kills = 0;
  promptFailuresRemaining = 0;

  constructor(
    readonly opts: AcpConnectionOptions,
    private behavior: { supportsLoadSession?: boolean; loadError?: Error; promptFailures?: number } = {},
  ) {
    this.promptFailuresRemaining = behavior.promptFailures ?? 0;
  }
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    this.supportsLoadSession = this.behavior.supportsLoadSession === true;
    return { agentCapabilities: { loadSession: this.supportsLoadSession, promptCapabilities: { image: true } } };
  }
  async newSession(): Promise<unknown> {
    this.newSessionCount++;
    return sessionSetup(`new-${this.opts.id}-${this.newSessionCount}`);
  }
  async loadSession(sessionId: string, cwd: string, mcpServers: any[]): Promise<unknown> {
    if (this.behavior.loadError) throw this.behavior.loadError;
    this.loadCalls.push({ sessionId, cwd, mcpServers });
    return sessionSetup(sessionId);
  }
  async prompt(text: string, _images?: unknown, turn?: any): Promise<unknown> {
    this.prompts.push(text);
    if (turn) {
      this.opts.onPromptQueued?.(turn);
      this.opts.onPromptStarted?.(turn);
    }
    if (this.promptFailuresRemaining > 0) {
      this.promptFailuresRemaining--;
      throw new Error("prompt failed");
    }
    return { stopReason: "end_turn" };
  }
  async steerPrompt(text: string): Promise<unknown> {
    return this.prompt(text);
  }
  async setMode(modeId: string): Promise<void> {
    this.setModes.push(modeId);
  }
  async setModel(modelId: string): Promise<void> {
    this.setModels.push(modelId);
  }
  async cancel(): Promise<void> {}
  kill(): void {
    this.kills++;
  }
}

class DeferredPromptConnection {
  prompts: Array<{ text: string; resolve: (value?: unknown) => void; reject: (err: unknown) => void }> = [];

  prompt(text: string): Promise<unknown> {
    return new Promise((resolve, reject) => this.prompts.push({ text, resolve, reject }));
  }
}

class RecordingSteerConnection {
  prompts: Array<{ text: string; resolve: (value?: unknown) => void; reject: (err: unknown) => void }> = [];
  cancels = 0;

  prompt(text: string): Promise<unknown> {
    return new Promise((resolve, reject) => this.prompts.push({ text, resolve, reject }));
  }
  steerPrompt(text: string): Promise<unknown> {
    return new Promise((resolve, reject) => this.prompts.push({ text, resolve, reject }));
  }
  async cancel(): Promise<void> {
    this.cancels++;
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

test("steer mail validates permissions, emits steer, and uses front delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-steer-"));
  const config: MeshConfig = {
    name: "steer",
    agents: [
      { id: "router", harness: "claude", project: ".", role: "router" },
      { id: "a", harness: "codex", project: ".", role: "member" },
      { id: "b", harness: "opencode", project: ".", role: "member" },
    ],
    edges: [
      { from: "a", to: "b", steer: true },
      { from: "a", to: "router", steer: true },
      { from: "router", to: "a" },
    ],
  };
  const cp = new ControlPlane(config, { mailboxPath: join(root, "mailbox.ndjson") });
  const fake = new RecordingSteerConnection();
  (cp as any).conns.set("b", fake);
  (cp as any).mesh.setStatus("b", "ready");
  const events: any[] = [];
  cp.on((e) => events.push(e));

  try {
    expect(await (cp as any).handleSteerMail({ agentId: "a", role: "member" }, "ghost", "x")).toMatch(/no such agent.*send_mail/i);
    expect(await (cp as any).handleSteerMail({ agentId: "a", role: "member" }, "a", "x")).toMatch(/yourself.*send_mail/i);
    expect(await (cp as any).handleSteerMail({ agentId: "b", role: "member" }, "a", "x")).toMatch(/not allowed.*send_mail/i);
    expect(await (cp as any).handleSteerMail({ agentId: "router", role: "router" }, "a", "x")).toMatch(/not enabled.*send_mail/i);
    expect(await (cp as any).handleSteerMail({ agentId: "a", role: "member" }, "router", "x")).toMatch(/router.*send_mail/i);

    expect(await (cp as any).handleSteerMail({ agentId: "a", role: "member" }, "b", "urgent")).toMatch(/steered to b/i);
    expect(fake.cancels).toBe(0);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0].text).toContain("[STEER #1 from a]: urgent");
    expect(events).toContainEqual(expect.objectContaining({ kind: "steer", from: "a", to: "b", body: "urgent" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "b", activity: "working" }));

    fake.prompts[0].resolve({});
    await Promise.resolve();
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "b", activity: "idle" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operator steer emits audit activity and uses steerPrompt without direct cancel", async () => {
  const cp = new ControlPlane(DEMO_MESH);
  const fake = new RecordingSteerConnection();
  (cp as any).conns.set("codex-1", fake);
  (cp as any).mesh.setStatus("codex-1", "ready");
  const events: any[] = [];
  cp.on((e) => events.push(e));

  await cp.steer("codex-1", "urgent redirect");

  expect(fake.cancels).toBe(0);
  expect(fake.prompts).toHaveLength(1);
  expect(fake.prompts[0].text).toContain("[STEER from operator]: urgent redirect");
  expect(events).toContainEqual(expect.objectContaining({ kind: "steer", from: "operator", to: "codex-1", body: "urgent redirect" }));
  fake.prompts[0].resolve({});
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
    (cp as any).noteTurnQueued({
      id: "queued-turn",
      agent: "router",
      source: "operator",
      from: "operator",
      to: "router",
      text: "queued work",
      preview: "you: queued work",
      ts: "T",
    });
    expect(cp.snapshotEvents()).toContainEqual(expect.objectContaining({
      kind: "agent_turn",
      phase: "queued",
      turn: expect.objectContaining({ id: "queued-turn", agent: "router", preview: "you: queued work" }),
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

test("setEffort dynamically switches supported thought_level config options and persists runtime effort", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "mesh-control-plane-effort-run-"));
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-effort-"));
  const config: MeshConfig = {
    name: "dynamic-effort",
    agents: [
      { id: "claude", harness: "claude", project: root, role: "router" },
      { id: "kimi", harness: "kimi", project: root, role: "member" },
      { id: "codex", harness: "codex", project: root, role: "member" },
      { id: "cold", harness: "claude", project: root, role: "member", lazy: true },
    ],
    edges: [],
  };
  const created: Record<string, ConfigOptionsConnection> = {};
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const conn = new ConfigOptionsConnection(opts);
      created[opts.id] = conn;
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    await cp.setEffort("claude", "high");
    await cp.setEffort("kimi", "low");
    await cp.setEffort("codex", "high");
    await cp.setEffort("cold", "medium");

    expect(created.claude.setConfigOptions).toContainEqual({ configId: "thought_level", value: "high" });
    expect(created.kimi.setConfigOptions).toContainEqual({ configId: "thinking", value: "off" });
    expect(created.codex.setConfigOptions).toEqual([]);
    expect(await readSessionState(runDir, "dynamic-effort")).toEqual(expect.objectContaining({
      agents: expect.objectContaining({
        claude: expect.objectContaining({ effort: "high" }),
        kimi: expect.objectContaining({ effort: "low" }),
        codex: expect.objectContaining({ effort: "high" }),
      }),
    }));
    expect(created.cold).toBeUndefined();
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test("start applies codex bypass by switching to full-access mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-bypass-"));
  class BypassModesConnection extends ResumeConnection {
    async newSession(): Promise<unknown> {
      return {
        sessionId: "bypass-session",
        modes: {
          currentModeId: "read-only",
          availableModes: [
            { id: "read-only", name: "Read Only" },
            { id: "full-access", name: "Full Access" },
          ],
        },
      };
    }
  }
  const config: MeshConfig = {
    name: "bypass-start",
    agents: [{ id: "router", harness: "codex", project: root, role: "router", bypass: true }],
    edges: [],
  };
  let conn: ResumeConnection | undefined;
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      conn = new BypassModesConnection(opts);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await cp.start();
    expect(conn?.setModes).toEqual(["full-access"]);
    expect(cp.snapshotEvents()).toContainEqual(expect.objectContaining({ kind: "agent_modes", agent: "router", current: "full-access" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("start applies codex model plus default low effort and maps UI current to configOptions", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "mesh-control-plane-model-run-"));
  const { root, cp, conn, events } = await startOneAgentWithModel({
    harness: "codex",
    model: "gpt-5.5",
    session: codexModels("gpt-5.4/low", ["gpt-5.4", "gpt-5.5"]),
    sessionRunDir: runDir,
  });
  try {
    expect(conn.setModels).toEqual(["gpt-5.5/low"]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "agent_models",
      agent: "router",
      current: "gpt-5.5",
      available: [
        { id: "gpt-5.4", name: "Config gpt-5.4" },
        { id: "gpt-5.5", name: "Config gpt-5.5" },
      ],
    }));
    expect(await readSessionState(runDir, "model-select")).toEqual(expect.objectContaining({
      agents: expect.objectContaining({
        router: expect.objectContaining({ model: "gpt-5.5/low" }),
      }),
    }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test("start applies desired model from configOptions when standard models are absent", async () => {
  const { root, cp, conn, events } = await startOneAgentWithModel({
    model: "preferred-config",
    session: configModels("default-config", ["default-config", "preferred-config"]),
  });
  try {
    expect(conn.setModels).toEqual(["preferred-config"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_models", agent: "router", current: "preferred-config" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("start applies codex model plus effort combination when advertised", async () => {
  const { root, cp, conn, events } = await startOneAgentWithModel({
    harness: "codex",
    model: "gpt-5.5",
    effort: "high",
    session: codexModels("gpt-5.5/low", ["gpt-5.4", "gpt-5.5"]),
  });
  try {
    expect(conn.setModels).toEqual(["gpt-5.5/high"]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "agent_models",
      agent: "router",
      current: "gpt-5.5",
      available: [
        { id: "gpt-5.4", name: "Config gpt-5.4" },
        { id: "gpt-5.5", name: "Config gpt-5.5" },
      ],
    }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("start falls back to codex config model when model plus effort combination is absent", async () => {
  const { root, cp, conn, events } = await startOneAgentWithModel({
    harness: "codex",
    model: "gpt-5.5",
    effort: "high",
    session: {
      ...standardModels("gpt-5.4/low", ["gpt-5.4/low", "gpt-5.4/medium"]),
      ...configModels("gpt-5.4", ["gpt-5.4", "gpt-5.5"]),
    },
  });
  try {
    expect(conn.setModels).toEqual(["gpt-5.5"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_models", agent: "router", current: "gpt-5.5" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("start keeps default model and emits a log when desired model is not advertised", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const { root, cp, conn, events } = await startOneAgentWithModel({
    model: "stale-model",
    session: standardModels("default-standard", ["default-standard", "other-model"]),
  });
  try {
    expect(conn.setModels).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_models", agent: "router", current: "default-standard" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "log", text: expect.stringContaining("skip cached model router=stale-model: not advertised") }));
    expect(warn).toHaveBeenCalledWith("skip cached model router=stale-model: not advertised");
  } finally {
    warn.mockRestore();
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("start leaves model untouched when no desired model is configured", async () => {
  const { root, cp, conn, events } = await startOneAgentWithModel({
    session: standardModels("default-standard", ["default-standard", "other-model"]),
  });
  try {
    expect(conn.setModels).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_models", agent: "router", current: "default-standard" }));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "log", text: expect.stringContaining("model") }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("start persists fresh session identity into the sessions store", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-sessions-"));
  const config: MeshConfig = {
    name: "session-capture",
    agents: [{ id: "router", harness: "opencode", project: root, role: "router", mode: "plan", model: "deepseek-v3", effort: "high" }],
    edges: [],
  };
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: join(root, "run"),
    connectionFactory: (opts) => new ConfigOptionsConnection(opts) as unknown as AcpAgentConnection,
  });

  try {
    await cp.start();
    expect(await readSessionState(join(root, "run"), "session-capture")).toEqual({
      meshExpectedAlive: true,
      agents: {
        router: {
          sessionId: "s-router",
          cwd: root,
          harness: "opencode",
          model: "deepseek-v3",
          mode: "plan",
          effort: "high",
        },
      },
    });
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("start loads a saved session when supported and skips mesh briefing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-resume-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "resume-load",
    agents: [{ id: "router", harness: "codex", project: root, role: "router", mode: "build", model: "kimi-k2", effort: "medium" }],
    edges: [],
  };
  await writeSessionState(runDir, config.name, {
    meshExpectedAlive: true,
    agents: {
      router: { sessionId: "saved-session", cwd: root, harness: "codex", mode: "plan", model: "deepseek-v3", effort: "medium" },
    },
  });
  const created: ResumeConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const conn = new ResumeConnection(opts, { supportsLoadSession: true });
      created.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    expect(created).toHaveLength(1);
    expect(created[0].loadCalls[0]).toMatchObject({ sessionId: "saved-session", cwd: root });
    expect(created[0].newSessionCount).toBe(0);
    expect(created[0].setModes).toEqual(["plan"]);
    expect(created[0].setModels).toEqual(["deepseek-v3"]);

    await cp.prompt("router", "after resume");
    expect(created[0].prompts).toEqual(["after resume"]);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime mode selection is persisted for fresh and loaded replacement sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-runtime-mode-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "runtime-mode",
    agents: [{ id: "router", harness: "codex", project: root, role: "router", mode: "build", effort: "medium" }],
    edges: [],
  };
  const created: ResumeConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const conn = new ResumeConnection(opts, { supportsLoadSession: true });
      created.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    expect(created[0].setModes).toEqual(["build"]);

    await cp.setMode("router", "plan");
    expect((await readSessionState(runDir, config.name)).agents.router.mode).toBe("plan");

    await cp.newSession("router");
    expect(created).toHaveLength(2);
    expect(created[1].newSessionCount).toBe(1);
    expect(created[1].setModes).toEqual(["plan"]);
    expect((await readSessionState(runDir, config.name)).agents.router.mode).toBe("plan");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("load error falls back to a fresh session that receives briefing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-load-error-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "resume-fallback",
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
  };
  await writeSessionState(runDir, config.name, {
    meshExpectedAlive: true,
    agents: { router: { sessionId: "missing-session", cwd: root, harness: "codex" } },
  });
  let conn: ResumeConnection | undefined;
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      conn = new ResumeConnection(opts, { supportsLoadSession: true, loadError: new Error("resource not found") });
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    expect(conn?.loadCalls).toEqual([]);
    expect(conn?.newSessionCount).toBe(1);
    await cp.prompt("router", "fresh work");
    expect(conn?.prompts[0]).toContain("[MESH BRIEFING]");
    expect(conn?.prompts[0]).toContain("fresh work");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("first prompt after load failure fresh-starts and retries the same prompt once", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-first-prompt-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "first-prompt-fallback",
    agents: [{ id: "router", harness: "claude", project: root, role: "router" }],
    edges: [],
  };
  await writeSessionState(runDir, config.name, {
    meshExpectedAlive: true,
    agents: { router: { sessionId: "saved-session", cwd: root, harness: "claude" } },
  });
  const created: ResumeConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const conn = new ResumeConnection(opts, { supportsLoadSession: true, promptFailures: created.length === 0 ? 1 : 0 });
      created.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    const events: any[] = [];
    cp.on((event) => events.push(event));
    await cp.prompt("router", "do not lose this");
    expect(created).toHaveLength(2);
    expect(created[0].prompts).toEqual(["do not lose this"]);
    expect(created[1].newSessionCount).toBe(1);
    expect(created[1].prompts[0]).toContain("[MESH BRIEFING]");
    expect(created[1].prompts[0]).toContain("do not lose this");
    expect(events.filter((e) => e.kind === "agent_turn" && e.phase === "started" && e.turn.agent === "router")).toHaveLength(1);
    const phases = events.filter((e) => e.kind === "agent_turn" && e.turn.agent === "router").map((e) => e.phase);
    expect(phases).toEqual(["queued", "started"]);
    expect((cp as any).queuedTurns.get("router") ?? []).toEqual([]);
    expect(cp.snapshotEvents()).not.toContainEqual(expect.objectContaining({ kind: "agent_turn", phase: "queued" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent exit clears queued turns from snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-exit-queue-"));
  let routerOpts: AcpConnectionOptions | undefined;
  const config: MeshConfig = {
    name: "exit-queue",
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
  };
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      routerOpts = opts;
      return new FakeAcpConnection(opts) as unknown as AcpAgentConnection;
    },
  });

  try {
    await cp.start();
    routerOpts!.onPromptQueued?.({
      id: "queued-before-exit",
      agent: "router",
      source: "operator",
      text: "will never start",
      preview: "you: will never start",
      ts: "T",
    });
    expect(cp.snapshotEvents()).toContainEqual(
      expect.objectContaining({
        kind: "agent_turn",
        phase: "queued",
        turn: expect.objectContaining({ id: "queued-before-exit" }),
      }),
    );

    routerOpts!.onExit?.(9);
    expect(cp.snapshotEvents()).not.toContainEqual(
      expect.objectContaining({
        kind: "agent_turn",
        phase: "queued",
        turn: expect.objectContaining({ id: "queued-before-exit" }),
      }),
    );
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("meshExpectedAlive false skips startup; prompt to dead agent starts fresh and flips flag true", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-dead-prompt-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "dead-prompt",
    agents: [{ id: "router", harness: "kimi", project: root, role: "router" }],
    edges: [],
  };
  await writeSessionState(runDir, config.name, {
    meshExpectedAlive: false,
    agents: { router: { sessionId: "old-session", cwd: root, harness: "kimi" } },
  });
  const created: ResumeConnection[] = [];
  const events: any[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const conn = new ResumeConnection(opts, { supportsLoadSession: true });
      created.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });
  cp.on((event) => events.push(event));

  try {
    await cp.start();
    expect(created).toHaveLength(0);
    expect(cp.snapshotEvents()).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "router", status: "dead" }));

    await cp.prompt("router", "revive");
    expect(created).toHaveLength(1);
    expect(created[0].loadCalls).toEqual([]);
    expect(created[0].newSessionCount).toBe(1);
    expect(created[0].prompts[0]).toContain("[MESH BRIEFING]");
    expect(created[0].prompts[0]).toContain("revive");
    expect((await readSessionState(runDir, config.name)).meshExpectedAlive).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "router", status: "dead", detail: "stopped" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "router", status: "ready" }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit stop clears meshExpectedAlive while shutdown cleanup leaves it unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-control-plane-stop-flag-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "stop-flag",
    agents: [{ id: "router", harness: "opencode", project: root, role: "router" }],
    edges: [],
  };
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => new ResumeConnection(opts) as unknown as AcpAgentConnection,
  });

  try {
    await cp.start();
    expect((await readSessionState(runDir, config.name)).meshExpectedAlive).toBe(true);
    await cp.stop("shutdown");
    expect((await readSessionState(runDir, config.name)).meshExpectedAlive).toBe(true);
    await cp.stop("explicit");
    expect((await readSessionState(runDir, config.name)).meshExpectedAlive).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
