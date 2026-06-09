import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { readSessionState, writeSessionState } from "./session-storage";

function sessionSetup(sessionId: string): unknown {
  return { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } };
}

// Globally-unique session ids across connection instances (real ids never collide).
let sidSeq = 0;

class ResumeConnection {
  supportsLoadSession = false;
  newSessionCount = 0;
  loadCalls: any[] = [];
  prompts: string[] = [];
  kills = 0;
  constructor(readonly opts: AcpConnectionOptions, private behavior: { supportsLoadSession?: boolean } = {}) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    this.supportsLoadSession = this.behavior.supportsLoadSession === true;
    return { agentCapabilities: { loadSession: this.supportsLoadSession, promptCapabilities: { image: true } } };
  }
  async newSession(): Promise<unknown> {
    this.newSessionCount++;
    return sessionSetup(`new-${this.opts.id}-${++sidSeq}`);
  }
  async loadSession(sessionId: string, cwd: string, mcpServers: any[]): Promise<unknown> {
    this.loadCalls.push({ sessionId, cwd, mcpServers });
    return sessionSetup(sessionId);
  }
  async prompt(text: string): Promise<unknown> { this.prompts.push(text); return { stopReason: "end_turn" }; }
  async steerPrompt(text: string): Promise<unknown> { return this.prompt(text); }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void { this.kills++; }
}

test("newSession on a live agent respawns fresh and replaces the stored session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-newsession-live-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "ns-live",
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
  };
  const created: ResumeConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const c = new ResumeConnection(opts, { supportsLoadSession: true });
      created.push(c);
      return c as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    const firstSid = (await readSessionState(runDir, config.name)).agents.router.sessionId;
    await cp.newSession("router");
    expect(created).toHaveLength(2); // old killed, new spawned
    expect(created[0].kills).toBeGreaterThan(0);
    expect(created[1].newSessionCount).toBe(1); // fresh, not loaded
    expect(created[1].loadCalls).toEqual([]);
    const nextSid = (await readSessionState(runDir, config.name)).agents.router.sessionId;
    expect(nextSid).not.toBe(firstSid);
    expect(events).toContainEqual(expect.objectContaining({ kind: "update", agent: "router", update: { sessionUpdate: "__session_reset__" } }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("newSession on a not-running agent clears the stored id WITHOUT spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-newsession-dead-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "ns-dead",
    agents: [{ id: "router", harness: "kimi", project: root, role: "router" }],
    edges: [],
  };
  // meshExpectedAlive:false => start() spawns nothing; agent is "dead".
  await writeSessionState(runDir, config.name, {
    meshExpectedAlive: false,
    agents: { router: { sessionId: "old-session", cwd: root, harness: "kimi", mode: "build" } },
  });
  const created: ResumeConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const c = new ResumeConnection(opts, { supportsLoadSession: true });
      created.push(c);
      return c as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    expect(created).toHaveLength(0);
    await cp.newSession("router");
    expect(created).toHaveLength(0); // never resurrected
    const rec = (await readSessionState(runDir, config.name)).agents.router;
    expect(rec.sessionId).toBe(""); // invalidated
    expect(rec.mode).toBe("build"); // other fields kept
    expect(events).toContainEqual(expect.objectContaining({ kind: "update", agent: "router", update: { sessionUpdate: "__session_reset__" } }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("newAllSessions resets every agent (mix of live and not-running)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-newsession-all-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "ns-all",
    agents: [
      { id: "router", harness: "codex", project: root, role: "router" },
      { id: "m1", harness: "claude", project: root, role: "member", lazy: true },
    ],
    edges: [{ from: "router", to: "m1" }],
  };
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => new ResumeConnection(opts, { supportsLoadSession: true }) as unknown as AcpAgentConnection,
  });
  try {
    await cp.start(); // router spawns; m1 is lazy/cold
    await cp.newAllSessions();
    const state = await readSessionState(runDir, config.name);
    // router got a fresh persisted id (regenerated); m1 had no live session so stays absent.
    expect(state.agents.router.sessionId).toMatch(/^new-router-/);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
