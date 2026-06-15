import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { AcpAgentConnection } from "./client";

test("recordStreamState tracks usage and advertised commands for control-plane callbacks", () => {
  const calls: any[] = [];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).contextUsage = null;
  (c as any).advertisedCommands = new Set<string>();
  (c as any).opts = {
    onContextUsage: (usage: any) => calls.push(["usage", usage]),
    onAvailableCommands: (commands: string[]) => calls.push(["commands", commands]),
  };

  (c as any).recordStreamState({ sessionUpdate: "usage_update", used: 23, size: 100 });
  (c as any).recordStreamState({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "/compact" }, { name: "review" }],
  });

  expect((c as any).contextUsage).toEqual({ used: 23, size: 100, percent: 0.23 });
  expect(Array.from((c as any).advertisedCommands)).toEqual(["compact", "review"]);
  expect(calls).toEqual([
    ["usage", { used: 23, size: 100, percent: 0.23 }],
    ["commands", ["compact", "review"]],
  ]);
});

test("prompt constructs ACP text plus readable image blocks and skips missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-acp-image-"));
  const img = join(root, "img.png");
  await writeFile(img, new Uint8Array([1, 2, 3]));
  const sent: any[] = [];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).conn = { prompt: async (p: any) => (sent.push(p), { stopReason: "end_turn" }) };
  (c as any).busy = false;
  (c as any).queue = [];
  try {
    await c.prompt("hi", [
      { id: "img.png", mimeType: "image/png", name: "img.png", path: img },
      { id: "missing.png", mimeType: "image/png", name: "missing.png", path: join(root, "missing.png") },
    ]);
    expect(sent[0].prompt).toHaveLength(2);
    expect(sent[0].prompt[0]).toEqual({ type: "text", text: "hi" });
    expect(sent[0].prompt[1]).toEqual({ type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initialize captures advertised loadSession support", async () => {
  const payloads: Array<{ name: string; res: any; expected: boolean }> = [
    { name: "codex", res: { agentCapabilities: { loadSession: true } }, expected: true },
    { name: "claude", res: { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }, expected: true },
    { name: "kimi", res: { agentCapabilities: { loadSession: true } }, expected: true },
    { name: "opencode", res: { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }, expected: true },
    { name: "synthetic-false", res: { agentCapabilities: { loadSession: false } }, expected: false },
    { name: "synthetic-missing", res: { agentCapabilities: {} }, expected: false },
  ];

  for (const payload of payloads) {
    const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
    (c as any).id = payload.name;
    (c as any).supportsLoadSession = false;
    (c as any).conn = {
      initialize: async () => payload.res,
    };

    expect(await c.initialize()).toEqual(payload.res);
    expect(c.supportsLoadSession).toBe(payload.expected);
  }
});

test("initialize can omit filesystem client capabilities", async () => {
  const calls: any[] = [];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "no-fs";
  (c as any).supportsLoadSession = false;
  (c as any).opts = { fs: false };
  (c as any).conn = {
    initialize: async (params: any) => {
      calls.push(params);
      return { agentCapabilities: {} };
    },
  };

  await c.initialize();

  expect(calls[0].clientCapabilities.fs).toBeUndefined();
  expect(calls[0].clientCapabilities.terminal).toBe(false);
});

test("setModel writes one raw ACP session/set_model line to child stdin", async () => {
  const chunks: Uint8Array[] = [];
  let flushes = 0;
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).rawRequestSeq = 0;
  (c as any).child = {
    stdin: {
      write(chunk: Uint8Array) {
        chunks.push(chunk);
      },
      flush() {
        flushes++;
      },
    },
  };
  await c.setModel("deepseek/deepseek-chat");
  expect(flushes).toBe(1);
  expect(chunks).toHaveLength(1);
  expect(new TextDecoder().decode(chunks[0])).toBe(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "mesh-set-model-1",
      method: "session/set_model",
      params: { sessionId: "s", modelId: "deepseek/deepseek-chat" },
    }) + "\n",
  );
});

test("setConfigOption writes one raw ACP session/set_config_option line to child stdin", async () => {
  const chunks: Uint8Array[] = [];
  let flushes = 0;
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).rawRequestSeq = 0;
  (c as any).child = {
    stdin: {
      write(chunk: Uint8Array) {
        chunks.push(chunk);
      },
      flush() {
        flushes++;
      },
    },
  };
  await c.setConfigOption("thinking", "off");
  expect(flushes).toBe(1);
  expect(chunks).toHaveLength(1);
  expect(new TextDecoder().decode(chunks[0])).toBe(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "mesh-set-config-option-1",
      method: "session/set_config_option",
      params: { sessionId: "s", configId: "thinking", value: "off" },
    }) + "\n",
  );
});

test("loadSession wraps ACP session/load and returns a session setup shape", async () => {
  const calls: any[] = [];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).conn = {
    loadSession: async (params: any) => {
      calls.push(params);
      return {
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
        configOptions: [{ category: "model", currentValue: "m", options: [{ value: "m", name: "m" }] }],
      };
    },
  };

  const res = await c.loadSession("saved-session", "/tmp/worktree", [{ type: "http", name: "mesh", url: "http://mesh", headers: [] }]);

  expect(calls).toEqual([{ sessionId: "saved-session", cwd: "/tmp/worktree", mcpServers: [{ type: "http", name: "mesh", url: "http://mesh", headers: [] }] }]);
  expect(c.sessionId).toBe("saved-session");
  expect(res as any).toEqual({
    sessionId: "saved-session",
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
    configOptions: [{ category: "model", currentValue: "m", options: [{ value: "m", name: "m" }] }],
  });
});

test("claude newSession requests raw SDK messages for silence visibility", async () => {
  const calls: any[] = [];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "claude";
  (c as any).opts = { command: "claude-agent-acp" };
  (c as any).conn = {
    newSession: async (params: any) => {
      calls.push(params);
      return { sessionId: "s" };
    },
  };

  await c.newSession([{ type: "http", name: "mesh", url: "http://mesh", headers: [] }]);

  expect(calls[0]._meta.claudeCode.emitRawSDKMessages).toEqual([
    { type: "rate_limit_event" },
    { type: "system", subtype: "api_retry" },
    { type: "system", subtype: "status" },
    { type: "system", subtype: "compact_boundary" },
    { type: "system", subtype: "init" },
  ]);
});

test("claude loadSession requests raw SDK messages for silence visibility", async () => {
  const calls: any[] = [];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "claude";
  (c as any).opts = { command: "claude-agent-acp" };
  (c as any).conn = {
    loadSession: async (params: any) => {
      calls.push(params);
      return { modes: { currentModeId: "default", availableModes: [] } };
    },
  };

  await c.loadSession("saved", "/tmp/project", [{ type: "http", name: "mesh", url: "http://mesh", headers: [] }]);

  expect(calls[0]._meta.claudeCode.emitRawSDKMessages).toEqual([
    { type: "rate_limit_event" },
    { type: "system", subtype: "api_retry" },
    { type: "system", subtype: "status" },
    { type: "system", subtype: "compact_boundary" },
    { type: "system", subtype: "init" },
  ]);
});

test("client handlers route only claude sdk ext notifications", async () => {
  const ext: any[] = [];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).opts = {
    onExtNotification: (method: string, params: unknown) => ext.push({ method, params }),
  };

  const client = (c as any).clientHandlers();
  await client.extNotification({ method: "_claude/sdkMessage", params: { type: "system", subtype: "api_retry" } });
  await client.extNotification({ method: "_other/noop", params: { ignored: true } });

  expect(ext).toEqual([{ method: "_claude/sdkMessage", params: { type: "system", subtype: "api_retry" } }]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("steerPrompt cancels the busy turn and runs before ordinary queued prompts", async () => {
  const sent: string[] = [];
  const turns = [deferred<any>(), deferred<any>(), deferred<any>()];
  let cancels = 0;
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).busy = false;
  (c as any).queue = [];
  (c as any).conn = {
    prompt: ({ prompt }: any) => {
      sent.push(prompt[0].text);
      return turns[sent.length - 1]!.promise;
    },
    cancel: async () => {
      cancels++;
    },
  };

  const a = c.prompt("A");
  const b = c.prompt("B");
  const s = c.steerPrompt("S");
  expect(cancels).toBe(1);
  expect(sent).toEqual(["A"]);

  turns[0]!.resolve({ stopReason: "cancelled" });
  await waitFor(() => sent.length === 2);
  expect(sent).toEqual(["A", "S"]);

  turns[1]!.resolve({ stopReason: "end_turn" });
  await s;
  await waitFor(() => sent.length === 3);
  expect(sent).toEqual(["A", "S", "B"]);

  turns[2]!.resolve({ stopReason: "end_turn" });
  await a;
  await b;
});

test("consecutive steerPrompt jobs stay FIFO and ahead of normal queued prompts", async () => {
  const sent: string[] = [];
  const turns = [deferred<any>(), deferred<any>(), deferred<any>(), deferred<any>()];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).busy = false;
  (c as any).queue = [];
  (c as any).conn = {
    prompt: ({ prompt }: any) => {
      sent.push(prompt[0].text);
      return turns[sent.length - 1]!.promise;
    },
    cancel: async () => {},
  };

  const a = c.prompt("A");
  const b = c.prompt("B");
  const s1 = c.steerPrompt("S1");
  const s2 = c.steerPrompt("S2");

  turns[0]!.resolve({ stopReason: "cancelled" });
  await waitFor(() => sent.length === 2);
  expect(sent).toEqual(["A", "S1"]);

  turns[1]!.resolve({ stopReason: "end_turn" });
  await s1;
  await waitFor(() => sent.length === 3);
  expect(sent).toEqual(["A", "S1", "S2"]);

  turns[2]!.resolve({ stopReason: "end_turn" });
  await s2;
  await waitFor(() => sent.length === 4);
  expect(sent).toEqual(["A", "S1", "S2", "B"]);

  turns[3]!.resolve({ stopReason: "end_turn" });
  await a;
  await b;
});

test("removeQueued drops matching queued jobs without touching the in-flight turn", async () => {
  const sent: string[] = [];
  const turns = [deferred<any>(), deferred<any>()];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).busy = false;
  (c as any).queue = [];
  (c as any).opts = {};
  (c as any).conn = {
    prompt: ({ prompt }: any) => {
      sent.push(prompt[0].text);
      return turns[sent.length - 1]!.promise;
    },
  };

  const a = c.prompt("A", [], { id: "a-turn", source: "mail", mailId: "m-a" } as any);
  const b = c.prompt("B", [], { id: "b-turn", source: "mail", mailId: "m-b" } as any);
  const d = c.prompt("C", [], { id: "c-turn", source: "operator" } as any);
  await waitFor(() => sent.length === 1);

  const removed = c.removeQueued((turn) => turn.source === "mail");
  expect(removed.map((t) => t.id)).toEqual(["b-turn"]);
  expect(await b).toEqual({ stopReason: "superseded" });

  turns[0]!.resolve({ stopReason: "end_turn" });
  await a;
  await waitFor(() => sent.length === 2);
  expect(sent).toEqual(["A", "C"]);
  turns[1]!.resolve({ stopReason: "end_turn" });
  await d;
});

test("kill() settles the in-flight and queued prompt promises so callers never hang", async () => {
  // Repro for the respawn/new-session turnCount leak: when a connection is killed while a
  // turn is in flight, the underlying ACP prompt request never resolves on its own (the child
  // is gone and the stream just ends). If kill() does not settle the pending prompt promises,
  // the control plane's trackTurn().finally never runs and turnCounts leaks → activity sticks
  // on "working" forever. kill() must reject both the in-flight job and every queued job.
  const started: string[] = [];
  const turns = [deferred<any>(), deferred<any>()];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).busy = false;
  (c as any).queue = [];
  (c as any).alive = true;
  (c as any).opts = {};
  (c as any).conn = {
    prompt: ({ prompt }: any) => {
      started.push(prompt[0].text);
      return turns[started.length - 1]!.promise; // never settles on its own
    },
  };

  const inflight = c.prompt("A", [], { id: "a-turn" } as any); // reaches pump → in-flight
  const queued = c.prompt("B", [], { id: "b-turn" } as any); // stays queued behind A
  await waitFor(() => started.length === 1);

  const settled: Record<string, "resolved" | "rejected"> = {};
  void inflight.then(() => (settled.inflight = "resolved"), () => (settled.inflight = "rejected"));
  void queued.then(() => (settled.queued = "resolved"), () => (settled.queued = "rejected"));

  c.kill();

  await waitFor(() => settled.inflight !== undefined && settled.queued !== undefined);
  expect(settled.inflight).toBe("rejected");
  expect(settled.queued).toBe("rejected");
});

test("prompt() on a killed connection rejects instead of enqueuing a turn that can never settle", () => {
  // Defense-in-depth backstop for the respawn leak: once a connection is killed its child is
  // gone, so any further prompt would enqueue a turn whose ACP request never resolves. The
  // control plane should not route prompts to a superseded conn, but if one slips through the
  // killed conn must reject synchronously so trackTurn().finally still releases the count.
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).busy = false;
  (c as any).queue = [];
  (c as any).alive = true;
  (c as any).opts = {};
  (c as any).conn = { prompt: () => new Promise(() => {}) }; // would hang forever

  c.kill();

  expect(() => c.prompt("late", [], { id: "late-turn" } as any)).toThrow(/killed/);
});

test("prompt queue emits queued immediately and started when a job reaches pump", async () => {
  const events: string[] = [];
  const turns = [deferred<any>(), deferred<any>()];
  const c = Object.create(AcpAgentConnection.prototype) as AcpAgentConnection;
  (c as any).id = "a";
  (c as any).sessionId = "s";
  (c as any).busy = false;
  (c as any).queue = [];
  (c as any).opts = {
    onPromptQueued: (meta: any) => events.push(`queued:${meta.id}`),
    onPromptStarted: (meta: any) => events.push(`started:${meta.id}`),
  };
  (c as any).conn = {
    prompt: () => turns[events.filter((e) => e.startsWith("started:")).length - 1]!.promise,
  };

  const a = c.prompt("A", [], { id: "a-turn" } as any);
  const b = c.prompt("B", [], { id: "b-turn" } as any);

  await waitFor(() => events.includes("started:a-turn"));
  expect(events).toEqual(["queued:a-turn", "started:a-turn", "queued:b-turn"]);

  turns[0]!.resolve({ stopReason: "end_turn" });
  await a;
  await waitFor(() => events.includes("started:b-turn"));
  expect(events).toEqual(["queued:a-turn", "started:a-turn", "queued:b-turn", "started:b-turn"]);

  turns[1]!.resolve({ stopReason: "end_turn" });
  await b;
});
