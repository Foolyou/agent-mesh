import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig, MeshEvent } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { writeSessionState } from "./session-storage";

function sessionSetup(sessionId: string): unknown {
  return { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } };
}

let sidSeq = 0;

// A connection whose loadSession replays history as a flood of session/update events,
// exactly as a real harness does when re-hydrating a saved session.
class ReplayConnection {
  supportsLoadSession = false;
  newSessionCount = 0;
  loadCalls = 0;
  constructor(
    readonly opts: AcpConnectionOptions,
    private behavior: { replayCount?: number; failLoad?: boolean } = {},
  ) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    this.supportsLoadSession = true;
    return { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } };
  }
  async newSession(): Promise<unknown> {
    this.newSessionCount++;
    return sessionSetup(`new-${this.opts.id}-${++sidSeq}`);
  }
  async loadSession(sessionId: string): Promise<unknown> {
    this.loadCalls++;
    // The harness re-emits the whole session history before loadSession resolves.
    const n = this.behavior.replayCount ?? 3;
    for (let i = 0; i < n; i++) {
      this.opts.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `history ${i}` } } as any);
    }
    if (this.behavior.failLoad) throw new Error("loadSession boom");
    return sessionSetup(sessionId);
  }
  async prompt(): Promise<unknown> { return { stopReason: "end_turn" }; }
  async steerPrompt(): Promise<unknown> { return { stopReason: "end_turn" }; }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {}
}

async function startWithSavedSession(
  root: string,
  behavior: { replayCount?: number; failLoad?: boolean },
): Promise<{ cp: ControlPlane; events: MeshEvent[]; created: ReplayConnection[] }> {
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "replay-mesh",
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
  };
  // Pre-seed a saved session so the resume (loadSession) path is taken on start.
  await writeSessionState(runDir, config.name, {
    meshExpectedAlive: true,
    agents: { router: { sessionId: "saved-sid-1", cwd: root, harness: "codex" } },
  });
  const created: ReplayConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const c = new ReplayConnection(opts, behavior);
      created.push(c);
      return c as unknown as AcpAgentConnection;
    },
  });
  const events: MeshEvent[] = [];
  cp.on((e) => events.push(e));
  await cp.start();
  return { cp, events, created };
}

test("loadSession history replay is bracketed by replay_started/replay_finished around the update flood", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-replay-"));
  try {
    const { cp, events, created } = await startWithSavedSession(root, { replayCount: 4 });
    expect(created[0].loadCalls).toBe(1);
    expect(created[0].newSessionCount).toBe(0); // loaded, not fresh

    const kinds = events.map((e) => e.kind);
    const started = kinds.indexOf("replay_started");
    const finished = kinds.indexOf("replay_finished");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(finished).toBeGreaterThan(started);

    // The replay updates must all land strictly between the bracketing events.
    const replayUpdates = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === "update" && (e as any).update?.content?.text?.startsWith?.("history"));
    expect(replayUpdates).toHaveLength(4);
    for (const { i } of replayUpdates) {
      expect(i).toBeGreaterThan(started);
      expect(i).toBeLessThan(finished);
    }
    await cp.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replay_finished is still emitted when loadSession throws (finally clears the flag)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-replay-fail-"));
  try {
    const { cp, events, created } = await startWithSavedSession(root, { replayCount: 2, failLoad: true });
    // loadSession threw → control-plane fell back to a fresh session.
    expect(created[0].loadCalls).toBe(1);
    expect(created[0].newSessionCount).toBe(1);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("replay_started");
    expect(kinds).toContain("replay_finished");
    expect(kinds.indexOf("replay_finished")).toBeGreaterThan(kinds.indexOf("replay_started"));
    await cp.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
