import { test, expect } from "bun:test";
import { probeHarnessModels, type HarnessModelProbeConnection } from "./harness-models";

class FakeConnection implements HarnessModelProbeConnection {
  killed = false;
  constructor(private session: unknown, private calls: string[]) {}
  async start(): Promise<void> {
    this.calls.push("start");
  }
  async initialize(): Promise<unknown> {
    this.calls.push("initialize");
    return {};
  }
  async newSession(): Promise<unknown> {
    this.calls.push("newSession");
    return this.session;
  }
  kill(): void {
    this.killed = true;
    this.calls.push("kill");
  }
}

function configSession(ids = ["gpt-5.4", "gpt-5.5"]) {
  return {
    configOptions: [
      {
        category: "model",
        currentValue: ids[0],
        options: ids.map((id) => ({ value: id, name: `Config ${id}` })),
      },
    ],
    models: {
      currentModelId: "combo-default",
      availableModels: [{ modelId: "ignored/high", name: "Ignored" }],
    },
  };
}

test("probeHarnessModels derives base models from configOptions first and kills the process", async () => {
  const calls: string[] = [];
  let conn: FakeConnection | undefined;
  const res = await probeHarnessModels("codex", {
    now: () => 1000,
    installed: () => true,
    createConnection: (_id, _spec, cwd) => {
      expect(cwd.length).toBeGreaterThan(0);
      conn = new FakeConnection(configSession(), calls);
      return conn;
    },
  });

  expect(res).toEqual({
    models: [
      { id: "gpt-5.4", name: "Config gpt-5.4" },
      { id: "gpt-5.5", name: "Config gpt-5.5" },
    ],
    probedAt: 1000,
  });
  expect(calls).toEqual(["start", "initialize", "newSession", "kill"]);
  expect(conn?.killed).toBe(true);
});

test("probeHarnessModels falls back to standard models and strips effort suffixes", async () => {
  const res = await probeHarnessModels("codex", {
    refresh: true,
    now: () => 2000,
    installed: () => true,
    createConnection: () =>
      new FakeConnection(
        {
          models: {
            currentModelId: "gpt-5.5/low",
            availableModels: [
              { modelId: "gpt-5.5/low", name: "GPT 5.5 low" },
              { modelId: "gpt-5.5/high", name: "GPT 5.5 high" },
              { modelId: "gpt-5.4/medium", name: "GPT 5.4 medium" },
            ],
          },
        },
        [],
      ),
  });

  expect(res.models).toEqual([
    { id: "gpt-5.5", name: "GPT 5.5 low" },
    { id: "gpt-5.4", name: "GPT 5.4 medium" },
  ]);
});

test("probeHarnessModels caches within TTL and refresh forces a new probe", async () => {
  let count = 0;
  const opts = {
    now: () => 3000,
    ttlMs: 60_000,
    installed: () => true,
    createConnection: () => new FakeConnection(configSession([`model-${++count}`]), []),
  };

  const first = await probeHarnessModels("claude", opts);
  const cached = await probeHarnessModels("claude", opts);
  const refreshed = await probeHarnessModels("claude", { ...opts, refresh: true });

  expect(first.models[0]?.id).toBe("model-1");
  expect(cached.models[0]?.id).toBe("model-1");
  expect(refreshed.models[0]?.id).toBe("model-2");
});

test("probeHarnessModels expires cache after TTL", async () => {
  let now = 0;
  let count = 0;
  const opts = {
    now: () => now,
    ttlMs: 100,
    installed: () => true,
    createConnection: () => new FakeConnection(configSession([`model-${++count}`]), []),
  };

  const first = await probeHarnessModels("opencode", opts);
  now = 99;
  const cached = await probeHarnessModels("opencode", opts);
  now = 101;
  const expired = await probeHarnessModels("opencode", opts);

  expect(first.models[0]?.id).toBe("model-1");
  expect(cached.models[0]?.id).toBe("model-1");
  expect(expired.models[0]?.id).toBe("model-2");
});

test("probeHarnessModels deduplicates concurrent probes for one harness", async () => {
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opts = {
    now: () => 4000,
    installed: () => true,
    createConnection: () => ({
      async start() {
        count += 1;
      },
      async initialize() {},
      async newSession() {
        await gate;
        return configSession(["shared-model"]);
      },
      kill() {},
    }),
  };

  const a = probeHarnessModels("kimi", opts);
  const b = probeHarnessModels("kimi", opts);
  release();
  const [ra, rb] = await Promise.all([a, b]);

  expect(count).toBe(1);
  expect(ra).toEqual(rb);
});

test("probeHarnessModels rejects uninstalled harnesses without spawning", async () => {
  let spawned = false;
  await expect(probeHarnessModels("kimi", {
    installed: () => false,
    createConnection: () => {
      spawned = true;
      return new FakeConnection(configSession(), []);
    },
  })).rejects.toThrow("harness kimi is not installed");
  expect(spawned).toBe(false);
});
