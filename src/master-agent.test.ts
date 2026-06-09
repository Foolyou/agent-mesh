import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import { MasterAgent } from "./master-agent";

class FakeAcpConnection {
  constructor(private opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return { agentCapabilities: { promptCapabilities: { image: true } } };
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `s-${this.opts.id}`, promptCapabilities: { image: false } };
  }
  async prompt(): Promise<unknown> {
    return { stopReason: "end_turn" };
  }
  kill(): void {}
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

test("master agent reports image capability advertised by initialize", async () => {
  const seen: Array<{ image: boolean }> = [];
  const master = new MasterAgent(fakeManager as any, {
    connectionFactory: (opts) => new FakeAcpConnection(opts) as unknown as AcpAgentConnection,
    onCapabilities: (caps) => seen.push(caps),
  });
  try {
    await master.start();
    expect(seen).toEqual([{ image: true }]);
  } finally {
    await master.stop();
  }
});

test("master agent defaults to the codex harness", async () => {
  let seen: AcpConnectionOptions | undefined;
  const master = new MasterAgent(fakeManager as any, {
    connectionFactory: (opts) => {
      seen = opts;
      return new FakeAcpConnection(opts) as unknown as AcpAgentConnection;
    },
  });
  try {
    await master.start();
    expect(seen?.command).toBe("codex-acp");
    expect(seen?.args).toEqual([]);
  } finally {
    await master.stop();
  }
});

test("master agent can be configured to use another harness", async () => {
  let seen: AcpConnectionOptions | undefined;
  const master = new MasterAgent(fakeManager as any, {
    harness: "claude",
    connectionFactory: (opts) => {
      seen = opts;
      return new FakeAcpConnection(opts) as unknown as AcpAgentConnection;
    },
  });
  try {
    await master.start();
    expect(seen?.command).toBe("claude-agent-acp");
    expect(seen?.args).toEqual([]);
  } finally {
    await master.stop();
  }
});

test("master agent starts in the configured assistant cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-master-root-"));
  const assistantCwd = join(root, "assistant");
  let seen: AcpConnectionOptions | undefined;
  const master = new MasterAgent(fakeManager as any, {
    cwd: assistantCwd,
    connectionFactory: (opts) => {
      seen = opts;
      return new FakeAcpConnection(opts) as unknown as AcpAgentConnection;
    },
  });
  try {
    await master.start();
    expect(seen?.cwd).toBe(assistantCwd);
    expect(existsSync(assistantCwd)).toBe(true);
  } finally {
    await master.stop();
    await rm(root, { recursive: true, force: true });
  }
});
