import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { AgentTurn, MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";

class SilentTaskConnection {
  kills = 0;
  activeTurn?: AgentTurn;
  releasePrompt?: () => void;

  constructor(readonly opts: AcpConnectionOptions) {}

  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    return {};
  }
  async newSession(): Promise<unknown> {
    return { sessionId: `s-${this.opts.id}-${Math.random()}` };
  }
  async prompt(_text: string, _images: unknown[] = [], turn?: AgentTurn): Promise<unknown> {
    this.activeTurn = turn;
    if (turn) this.opts.onPromptStarted?.(turn);
    await new Promise<void>((resolve) => { this.releasePrompt = resolve; });
    return { stopReason: "end_turn" };
  }
  async steerPrompt(text: string, images: unknown[] = [], turn?: AgentTurn): Promise<unknown> {
    return this.prompt(text, images, turn);
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void {
    this.kills++;
    this.releasePrompt?.();
  }
}

function config(root: string): MeshConfig {
  return {
    name: "silent-task-complete",
    agents: [
      { id: "router", harness: "codex", project: root, role: "router" },
      { id: "peer", harness: "codex", project: root, role: "member", lazy: true },
    ],
    edges: [{ from: "router", to: "peer" }],
  };
}

function taskComplete(lastAgentMessage: string | null): unknown {
  return {
    sessionUpdate: "event_msg",
    payload: {
      type: "task_complete",
      last_agent_message: lastAgentMessage,
    },
  };
}

async function withControlPlane(fn: (cp: ControlPlane, router: SilentTaskConnection, events: any[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cp-silent-task-complete-"));
  const created = new Map<string, SilentTaskConnection>();
  const cp = new ControlPlane(config(root), {
    mailboxPath: join(root, "mailbox.ndjson"),
    turnFirstSignalTimeoutMs: 0,
    connectionFactory: (opts) => {
      const conn = new SilentTaskConnection(opts);
      created.set(opts.id, conn);
      return conn as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    const router = created.get("router");
    if (!router) throw new Error("router connection missing");
    await fn(cp, router, events);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function startTurn(cp: ControlPlane, conn: SilentTaskConnection): Promise<{ prompt: Promise<unknown> }> {
  const prompt = cp.prompt("router", "work");
  await Bun.sleep(0);
  expect(conn.activeTurn).toBeDefined();
  return { prompt };
}

async function finishTurn(prompt: Promise<unknown>, conn: SilentTaskConnection): Promise<void> {
  conn.releasePrompt?.();
  await prompt;
}

test("silent task_complete increments count and emits event when no mail was sent", async () => {
  await withControlPlane(async (cp, router, events) => {
    const { prompt } = await startTurn(cp, router);

    router.opts.onPromptSignal?.(router.activeTurn, taskComplete(null));

    expect(cp.getAgentSilentTaskCompletes("router")).toMatchObject({ count: 1 });
    expect(cp.getAgentLastTurnCompletedAt("router")).toBeGreaterThan(0);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "silent_task_complete",
      agent: "router",
      turnId: router.activeTurn!.id,
    }));
    await finishTurn(prompt, router);
  });
});

test("silent task_complete does not trigger when the turn sent mail", async () => {
  await withControlPlane(async (cp, router) => {
    const { prompt } = await startTurn(cp, router);
    await (cp as any).handleSendMail({ agentId: "router" }, "peer", "[DONE] work finished");

    expect(cp.getAgentLastOutboundMailAt("router")).toBeGreaterThan(0);
    router.opts.onPromptSignal?.(router.activeTurn, taskComplete(null));

    expect(cp.getAgentSilentTaskCompletes("router")).toEqual({ count: 0, lastAt: null });
    expect(cp.getAgentLastTurnCompletedAt("router")).toBeGreaterThan(0);
    await finishTurn(prompt, router);
  });
});

test("silent task_complete does not trigger when codex produced a final message", async () => {
  await withControlPlane(async (cp, router) => {
    const { prompt } = await startTurn(cp, router);

    router.opts.onPromptSignal?.(router.activeTurn, taskComplete("done"));

    expect(cp.getAgentSilentTaskCompletes("router")).toEqual({ count: 0, lastAt: null });
    await finishTurn(prompt, router);
  });
});

test("silent task_complete count is cleared by fresh spawn", async () => {
  await withControlPlane(async (cp, router) => {
    const { prompt } = await startTurn(cp, router);
    router.opts.onPromptSignal?.(router.activeTurn, taskComplete(null));
    await finishTurn(prompt, router);

    await cp.respawnAgent("router", "force");

    expect(cp.getAgentSilentTaskCompletes("router")).toEqual({ count: 0, lastAt: null });
  });
});

test("silent task_complete counts multiple silent turns", async () => {
  await withControlPlane(async (cp, router) => {
    let { prompt } = await startTurn(cp, router);
    router.opts.onPromptSignal?.(router.activeTurn, taskComplete(null));
    await finishTurn(prompt, router);

    ({ prompt } = await startTurn(cp, router));
    router.opts.onPromptSignal?.(router.activeTurn, taskComplete(null));
    await finishTurn(prompt, router);

    expect(cp.getAgentSilentTaskCompletes("router")).toMatchObject({ count: 2 });
  });
});
