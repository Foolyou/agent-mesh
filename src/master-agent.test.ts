import { test, expect } from "bun:test";
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
