import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import { buildMeshAssistantBriefing } from "./mesh-assistant-briefing";
import { MeshAssistant } from "./mesh-assistant";

class FakeAcpConnection {
  prompts: string[] = [];
  newSessionArgs: unknown[][] = [];
  killed = false;
  static failures = new Map<string, "start" | "initialize" | "newSession">();
  constructor(private opts: AcpConnectionOptions) {}
  async start(): Promise<void> {
    if (FakeAcpConnection.failures.get(this.opts.command) === "start") throw new Error(`start failed ${this.opts.command}`);
  }
  async initialize(): Promise<unknown> {
    if (FakeAcpConnection.failures.get(this.opts.command) === "initialize") throw new Error(`initialize failed ${this.opts.command}`);
    return { agentCapabilities: { promptCapabilities: { image: true } } };
  }
  async newSession(...args: unknown[]): Promise<unknown> {
    if (FakeAcpConnection.failures.get(this.opts.command) === "newSession") throw new Error(`newSession failed ${this.opts.command}`);
    this.newSessionArgs.push(args);
    return { sessionId: `s-${this.opts.id}`, promptCapabilities: { image: false } };
  }
  async prompt(text: string): Promise<unknown> {
    this.prompts.push(text);
    return { stopReason: "end_turn" };
  }
  kill(): void {
    this.killed = true;
  }
}

const fakeManager = {
  async defineMesh(): Promise<void> {},
  async deleteMesh(): Promise<void> {},
  configOf(): unknown {
    return {};
  },
  async startMesh(): Promise<void> {},
  async stopMesh(): Promise<void> {},
  listMeshes(): unknown[] {
    return [];
  },
  routerOf(): string {
    return "router";
  },
};

test("Mesh Assistant reports image capability advertised by initialize", async () => {
  const seen: Array<{ image: boolean; harness?: string }> = [];
  const assistant = new MeshAssistant(fakeManager as any, {
    connectionFactory: (opts) => new FakeAcpConnection(opts) as unknown as AcpAgentConnection,
    onCapabilities: (caps) => seen.push(caps),
  });
  try {
    await assistant.start();
    expect(seen).toEqual([{ image: true, harness: "codex" }]);
  } finally {
    await assistant.stop();
  }
});

test("Mesh Assistant defaults to the codex harness", async () => {
  let seen: AcpConnectionOptions | undefined;
  const assistant = new MeshAssistant(fakeManager as any, {
    connectionFactory: (opts) => {
      seen = opts;
      return new FakeAcpConnection(opts) as unknown as AcpAgentConnection;
    },
  });
  try {
    await assistant.start();
    expect(seen?.command).toBe("codex-acp");
    expect(seen?.args).toEqual([]);
    expect(seen?.fs).toBe(false);
  } finally {
    await assistant.stop();
  }
});

test("Mesh Assistant can be configured to use another harness", async () => {
  let seen: AcpConnectionOptions | undefined;
  const assistant = new MeshAssistant(fakeManager as any, {
    harness: "claude",
    connectionFactory: (opts) => {
      seen = opts;
      return new FakeAcpConnection(opts) as unknown as AcpAgentConnection;
    },
  });
  try {
    await assistant.start();
    expect(seen?.command).toBe("claude-agent-acp");
    expect(seen?.args).toEqual([]);
  } finally {
    await assistant.stop();
  }
});

test("Mesh Assistant tries explicit harness first, then default fallback order", async () => {
  FakeAcpConnection.failures = new Map([
    ["opencode", "initialize"],
    ["codex-acp", "initialize"],
  ]);
  const seen: AcpConnectionOptions[] = [];
  const conns: FakeAcpConnection[] = [];
  const assistant = new MeshAssistant(fakeManager as any, {
    harness: "opencode",
    installedHarnesses: [
      { id: "codex", installed: true },
      { id: "claude", installed: true },
      { id: "opencode", installed: true },
      { id: "kimi", installed: true },
    ],
    connectionFactory: (opts) => {
      seen.push(opts);
      const conn = new FakeAcpConnection(opts);
      conns.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await assistant.start();
    expect(seen.map((o) => o.command)).toEqual(["opencode", "codex-acp", "claude-agent-acp"]);
    expect(conns[0]!.killed).toBe(true);
    expect(conns[1]!.killed).toBe(true);
    expect(conns[2]!.killed).toBe(false);
    expect(assistant.harness).toBe("claude");
  } finally {
    FakeAcpConnection.failures = new Map();
    await assistant.stop();
  }
});

test("Mesh Assistant skips uninstalled fallbacks and fails only after all installed harnesses fail", async () => {
  FakeAcpConnection.failures = new Map([
    ["codex-acp", "start"],
    ["kimi", "newSession"],
  ]);
  const seen: AcpConnectionOptions[] = [];
  const conns: FakeAcpConnection[] = [];
  const assistant = new MeshAssistant(fakeManager as any, {
    installedHarnesses: [
      { id: "codex", installed: true },
      { id: "claude", installed: false },
      { id: "opencode", installed: false },
      { id: "kimi", installed: true },
    ],
    connectionFactory: (opts) => {
      seen.push(opts);
      const conn = new FakeAcpConnection(opts);
      conns.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await expect(assistant.start()).rejects.toThrow(/no Mesh Assistant harness started/);
    expect(seen.map((o) => o.command)).toEqual(["codex-acp", "kimi"]);
    expect(conns.every((c) => c.killed)).toBe(true);
  } finally {
    FakeAcpConnection.failures = new Map();
    await assistant.stop();
  }
});

test("Mesh Assistant starts in the configured assistant cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-assistant-root-"));
  const assistantCwd = join(root, "assistant");
  let seen: AcpConnectionOptions | undefined;
  const assistant = new MeshAssistant(fakeManager as any, {
    cwd: assistantCwd,
    connectionFactory: (opts) => {
      seen = opts;
      return new FakeAcpConnection(opts) as unknown as AcpAgentConnection;
    },
  });
  try {
    await assistant.start();
    expect(seen?.cwd).toBe(assistantCwd);
    expect(existsSync(assistantCwd)).toBe(true);
  } finally {
    await assistant.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mesh Assistant injects mesh-control MCP into the session", async () => {
  let conn: FakeAcpConnection | undefined;
  const assistant = new MeshAssistant(fakeManager as any, {
    connectionFactory: (opts) => {
      conn = new FakeAcpConnection(opts);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await assistant.start();
    expect(conn!.newSessionArgs[0]?.[0]).toEqual([
      expect.objectContaining({ type: "http", name: "mesh-control", headers: [] }),
    ]);
  } finally {
    await assistant.stop();
  }
});

test("Mesh Assistant prepends the control briefing only to the first user prompt", async () => {
  let conn: FakeAcpConnection | undefined;
  const assistant = new MeshAssistant(fakeManager as any, {
    connectionFactory: (opts) => {
      conn = new FakeAcpConnection(opts);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await assistant.start();
    await assistant.prompt("create a mesh named demo");
    await assistant.prompt("list meshes");

    const briefing = buildMeshAssistantBriefing();
    expect(conn!.prompts[0]?.startsWith(briefing)).toBe(true);
    expect(conn!.prompts[0]).toContain("create a mesh named demo");
    expect(conn!.prompts[1]).toBe("list meshes");
  } finally {
    await assistant.stop();
  }
});
