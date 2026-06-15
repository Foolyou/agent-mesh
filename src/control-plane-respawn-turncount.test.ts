import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig, MeshEvent } from "./acp/types";
import { ControlPlane } from "./control-plane";

function sessionSetup(sessionId: string): unknown {
  return { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } };
}

let sidSeq = 0;

/** A connection whose prompt turn never settles on its own — it only settles when the
 *  connection is killed, mirroring the real AcpAgentConnection contract: the child process is
 *  gone, the ACP request never resolves, and kill() must reject the pending prompt so the
 *  control plane's trackTurn().finally runs. This lets us assert the respawn/new-session
 *  turnCount leak is fixed end-to-end (activity returns to idle), not just at the conn layer. */
class HangingPromptConnection {
  supportsLoadSession = false;
  kills = 0;
  newSessionCount = 0;
  private pending: Array<(err: unknown) => void> = [];
  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return { agentCapabilities: { loadSession: false, promptCapabilities: { image: true } } };
  }
  async newSession(): Promise<unknown> {
    this.newSessionCount++;
    return sessionSetup(`new-${this.opts.id}-${++sidSeq}`);
  }
  async loadSession(sessionId: string): Promise<unknown> {
    return sessionSetup(sessionId);
  }
  prompt(): Promise<unknown> {
    return new Promise((_resolve, reject) => {
      this.pending.push(reject);
    });
  }
  steerPrompt(): Promise<unknown> {
    return this.prompt();
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {
    this.kills++;
    const pending = this.pending;
    this.pending = [];
    for (const reject of pending) reject(new Error(`${this.opts.id}: connection killed`));
  }
}

/** Like HangingPromptConnection, but it also advertises /compact and can report over-threshold
 *  context usage, so the control plane runs a pre-send auto-compaction whose /compact turn hangs.
 *  Records every prompt text so a test can assert the killed old connection never received the
 *  real prompt after a newSession superseded it mid-compaction. */
class CompactGatedConnection {
  prompts: string[] = [];
  kills = 0;
  private pending: Array<(err: unknown) => void> = [];
  constructor(readonly opts: AcpConnectionOptions) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    this.opts.onAvailableCommands?.(["compact"]);
    return { agentCapabilities: { loadSession: false, promptCapabilities: { image: true } } };
  }
  async newSession(): Promise<unknown> {
    return sessionSetup(`new-${this.opts.id}-${++sidSeq}`);
  }
  async loadSession(sessionId: string): Promise<unknown> {
    return sessionSetup(sessionId);
  }
  /** Push context usage over the auto-compact threshold (size >= MIN window, used/size >= 85%). */
  reportOverThreshold(): void {
    this.opts.onContextUsage?.({ used: 90_000, size: 100_000, percent: 0.9 });
  }
  prompt(text: string): Promise<unknown> {
    this.prompts.push(text);
    return new Promise((_resolve, reject) => {
      this.pending.push(reject);
    });
  }
  steerPrompt(text: string): Promise<unknown> {
    return this.prompt(text);
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {
    this.kills++;
    const pending = this.pending;
    this.pending = [];
    for (const reject of pending) reject(new Error(`${this.opts.id}: connection killed`));
  }
}

function latestActivity(events: MeshEvent[], id: string): string | undefined {
  return events.filter((e) => e.kind === "agent_activity" && (e as any).agent === id).map((e) => (e as any).activity).pop();
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("newSession on a working agent clears the leaked turnCount and returns activity to idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-respawn-turncount-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "respawn-leak",
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
  };
  const created: HangingPromptConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const c = new HangingPromptConnection(opts);
      created.push(c);
      return c as unknown as AcpAgentConnection;
    },
  });
  try {
    await cp.start();

    // Drive a real prompt turn that never settles → the agent is "working".
    // Fire-and-forget: when the old conn is killed the turn rejects; swallow it so the test
    // does not see an unhandled rejection (the production callers — wake()/runCompact — catch too).
    void cp.prompt("router", "do some long work").catch(() => {});
    await waitFor(() => latestActivity(cp.snapshotEvents(), "router") === "working");

    // Respawn the working agent. spawnAgent kills the superseded connection; the fix makes
    // kill() reject the in-flight turn so trackTurn().finally decrements turnCounts back to 0.
    await cp.newSession("router");
    expect(created).toHaveLength(2); // old killed, new spawned
    expect(created[0].kills).toBeGreaterThan(0);

    await waitFor(() => latestActivity(cp.snapshotEvents(), "router") === "idle");
    expect(latestActivity(cp.snapshotEvents(), "router")).toBe("idle");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("newSession during pre-send /compact never sends the real prompt to the superseded connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-respawn-compact-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "respawn-compact",
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
    autoCompact: { enabled: true, threshold: "85%" },
  };
  const created: CompactGatedConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const c = new CompactGatedConnection(opts);
      created.push(c);
      return c as unknown as AcpAgentConnection;
    },
  });
  try {
    await cp.start();

    // Drive the agent over its auto-compact threshold so a /compact turn starts and hangs.
    created[0].reportOverThreshold();
    await waitFor(() => created[0].prompts.some((p) => p.includes("/compact")));

    // Fire a real prompt: it enters sendPromptWithResumeFallback and suspends on `await
    // compactBeforePrompt(id)` (coalescing onto the in-flight /compact). Swallow the expected
    // rejection (the captured connection is about to be superseded).
    void cp.prompt("router", "REAL_WORK_PROMPT").catch(() => {});

    // Supersede the connection while the real prompt is still parked behind /compact. spawnAgent
    // kills the old conn → /compact rejects → the real prompt resumes; it MUST NOT be delivered
    // to the killed old connection (which would enqueue a turn that never settles → leak).
    await cp.newSession("router");
    expect(created).toHaveLength(2);
    expect(created[0].kills).toBeGreaterThan(0);

    await waitFor(() => latestActivity(cp.snapshotEvents(), "router") === "idle");
    // The killed old connection only ever saw /compact, never the real prompt.
    expect(created[0].prompts.some((p) => p.includes("REAL_WORK_PROMPT"))).toBe(false);
    // We chose to reject (not re-route), so the fresh connection did not receive it either.
    expect(created[1].prompts.some((p) => p.includes("REAL_WORK_PROMPT"))).toBe(false);
    expect(latestActivity(cp.snapshotEvents(), "router")).toBe("idle");
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
