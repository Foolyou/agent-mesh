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
    return { sessionId: `s-${this.opts.id}`, promptCapabilities: { image: false } };
  }
  async prompt(): Promise<unknown> {
    return { stopReason: "end_turn" };
  }
  async setMode(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {}
}

test("setMode throws for an unknown agent (no connection)", () => {
  const cp = new ControlPlane(DEMO_MESH);
  expect(() => cp.setMode("ghost", "read-only")).toThrow(/no connection/);
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
