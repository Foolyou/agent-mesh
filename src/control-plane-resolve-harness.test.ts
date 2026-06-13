import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { managedNpmBin } from "./harness-install-spec";

class ResolvedConnection {
  static versionById = new Map<string, string>();
  kills = 0;
  newSessionCount = 0;
  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {
      agentInfo: { version: ResolvedConnection.versionById.get(this.opts.id) ?? "1.0.0" },
      agentCapabilities: { promptCapabilities: { image: true } },
    };
  }
  async newSession(): Promise<unknown> {
    this.newSessionCount++;
    return { sessionId: `${this.opts.id}-${this.newSessionCount}` };
  }
  async prompt(): Promise<unknown> { return { stopReason: "end_turn" }; }
  async steerPrompt(): Promise<unknown> { return { stopReason: "end_turn" }; }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void { this.kills++; }
}

const config = (root: string): MeshConfig => ({
  name: "resolved",
  agents: [
    { id: "router", harness: "codex", project: root, role: "router" },
    { id: "lazy", harness: "claude", project: root, role: "member", lazy: true },
  ],
  edges: [{ from: "router", to: "lazy" }],
});

test("ControlPlane records resolved harness path and version for eager, lazy, and force respawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-resolved-harness-"));
  const originalWhich = Bun.which;
  const created: ResolvedConnection[] = [];
  ResolvedConnection.versionById = new Map([["router", "0.16.0"], ["lazy", "0.44.0"]]);
  Bun.which = ((command: string) => `/resolved/bin/${command}`) as typeof Bun.which;
  const cp = new ControlPlane(config(root), {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      const conn = new ResolvedConnection(opts);
      created.push(conn);
      return conn as unknown as AcpAgentConnection;
    },
  });
  try {
    await cp.start();
    expect(cp.getResolvedHarness("router")).toMatchObject({ agentId: "router", harnessId: "codex", path: "/resolved/bin/codex-acp", version: "0.16.0" });
    expect(cp.getResolvedHarness("lazy")).toBeUndefined();

    await cp.wakeAgent("lazy");
    expect(cp.getResolvedHarness("lazy")).toMatchObject({ agentId: "lazy", harnessId: "claude", path: "/resolved/bin/claude-agent-acp", version: "0.44.0" });

    ResolvedConnection.versionById.set("router", "0.16.1");
    await cp.newSession("router");
    expect(cp.getResolvedHarness("router")).toMatchObject({ agentId: "router", harnessId: "codex", path: "/resolved/bin/codex-acp", version: "0.16.1" });
  } finally {
    Bun.which = originalWhich;
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("ControlPlane clears resolved harness info on stopAgent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-resolved-clear-"));
  const originalWhich = Bun.which;
  Bun.which = ((command: string) => `/resolved/bin/${command}`) as typeof Bun.which;
  const cp = new ControlPlane(config(root), {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => new ResolvedConnection(opts) as unknown as AcpAgentConnection,
  });
  try {
    await cp.start();
    expect(cp.getResolvedHarness("router")).toBeDefined();
    await cp.stopAgent("router");
    expect(cp.getResolvedHarness("router")).toBeUndefined();
  } finally {
    Bun.which = originalWhich;
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("ControlPlane prioritizes managed npm bin in spawn PATH and resolved harness lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-managed-path-"));
  const originalWhich = Bun.which;
  const seen: AcpConnectionOptions[] = [];
  Bun.which = ((command: string, opts?: { PATH?: string }) => {
    if (command !== "codex-acp") return null;
    return opts?.PATH?.startsWith(`${managedNpmBin()}:`) ? `${managedNpmBin()}/codex-acp` : "/usr/local/bin/codex-acp";
  }) as typeof Bun.which;
  const cp = new ControlPlane(config(root), {
    mailboxPath: join(root, "mailbox.ndjson"),
    connectionFactory: (opts) => {
      seen.push(opts);
      return new ResolvedConnection(opts) as unknown as AcpAgentConnection;
    },
  });
  try {
    await cp.start();
    expect(seen[0].extraEnv?.PATH).toStartWith(`${managedNpmBin()}:`);
    expect(cp.getResolvedHarness("router")).toMatchObject({ path: `${managedNpmBin()}/codex-acp` });
  } finally {
    Bun.which = originalWhich;
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
