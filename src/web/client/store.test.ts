import { test, expect, mock } from "bun:test";
import { emptyState, applyMsg, createStore } from "./store";
import type { GatewayState, TranscriptItem } from "../types";

function seed(): GatewayState {
  return {
    appVersion: "build-1",
    meshes: [
      {
        name: "demo",
        defined: true,
        status: "running",
        router: "router",
        agents: [
          { id: "router", harness: "claude", role: "router", status: "ready", activity: "idle" },
          { id: "codex-1", harness: "codex", role: "member", status: "spawning", activity: "idle" },
        ],
        edges: [{ from: "router", to: "codex-1" }],
      },
    ],
    assistant: { status: "ready", transcript: [] },
    perMesh: {
      demo: { config: { name: "demo", agents: [], edges: [] }, transcripts: {}, activity: [], mail: [], pending: [], history: [], modes: {}, models: {}, efforts: {}, capabilities: {}, usage: {}, health: {}, selfAwareness: {}, queues: {} },
    },
  };
}

test("snapshot replaces state", () => {
  const s = applyMsg(emptyState(), { t: "snapshot", state: seed() });
  expect(s.meshes[0].name).toBe("demo");
  expect(s.appVersion).toBe("build-1");
});

test("store marks an upgrade available when a later snapshot has a different app version", () => {
  const store = createStore();
  store.apply({ t: "snapshot", state: { ...seed(), appVersion: "build-1" } });
  expect(store.getUpgrade()).toEqual({ available: false });

  store.apply({ t: "snapshot", state: { ...seed(), appVersion: "build-2" } });
  expect(store.getUpgrade()).toEqual({ available: true, current: "build-1", next: "build-2" });
});

test("store ignores snapshots without an app version for upgrade detection", () => {
  const store = createStore();
  store.apply({ t: "snapshot", state: { ...seed(), appVersion: undefined } });
  store.apply({ t: "snapshot", state: { ...seed(), appVersion: undefined } });
  expect(store.getUpgrade()).toEqual({ available: false });
});

test("mesh.status updates the summary", () => {
  const s = applyMsg(seed(), { t: "mesh.status", name: "demo", status: "dead" });
  expect(s.meshes[0].status).toBe("dead");
});

test("mesh.list replaces meshes", () => {
  const s = applyMsg(seed(), { t: "mesh.list", meshes: [] });
  expect(s.meshes).toHaveLength(0);
});

test("agent.status updates the agent row", () => {
  const s = applyMsg(seed(), { t: "agent.status", name: "demo", agent: "codex-1", status: "ready" });
  expect(s.meshes[0].agents.find((a) => a.id === "codex-1")!.status).toBe("ready");
});

test("agent.activity updates the agent row", () => {
  const s = applyMsg(seed(), { t: "agent.activity", name: "demo", agent: "codex-1", activity: "working" });
  expect(s.meshes[0].agents.find((a) => a.id === "codex-1")!.activity).toBe("working");
});

test("agent.modes stores the agent's session modes; a later one updates current", () => {
  let s = applyMsg(seed(), {
    t: "agent.modes",
    name: "demo",
    agent: "codex-1",
    current: "default",
    available: [{ id: "read-only", name: "read-only" }, { id: "default", name: "default" }],
  });
  expect(s.perMesh.demo.modes["codex-1"].current).toBe("default");
  expect(s.perMesh.demo.modes["codex-1"].available).toHaveLength(2);
  s = applyMsg(s, { t: "agent.modes", name: "demo", agent: "codex-1", current: "read-only", available: [{ id: "read-only", name: "read-only" }, { id: "default", name: "default" }] });
  expect(s.perMesh.demo.modes["codex-1"].current).toBe("read-only");
});

test("agent.models stores the agent's model choices; a later one updates current", () => {
  let s = applyMsg(seed(), {
    t: "agent.models",
    name: "demo",
    agent: "codex-1",
    current: "kimi-k2",
    available: [{ id: "kimi-k2", name: "kimi-k2" }, { id: "deepseek-v3", name: "deepseek-v3" }],
  });
  expect(s.perMesh.demo.models["codex-1"].current).toBe("kimi-k2");
  expect(s.perMesh.demo.models["codex-1"].available).toHaveLength(2);
  s = applyMsg(s, { t: "agent.models", name: "demo", agent: "codex-1", current: "deepseek-v3", available: [{ id: "kimi-k2", name: "kimi-k2" }, { id: "deepseek-v3", name: "deepseek-v3" }] });
  expect(s.perMesh.demo.models["codex-1"].current).toBe("deepseek-v3");
});

test("agent.efforts stores advertised runtime effort choices", () => {
  const s = applyMsg(seed(), {
    t: "agent.efforts",
    name: "demo",
    agent: "router",
    configId: "thought_level",
    current: "medium",
    available: [{ id: "low", name: "Low" }, { id: "max", name: "Max" }],
  });
  expect(s.perMesh.demo.efforts.router).toEqual({
    configId: "thought_level",
    current: "medium",
    available: [{ id: "low", name: "Low" }, { id: "max", name: "Max" }],
  });
});

test("transcript.upsert then patch on an agent conv", () => {
  let s = seed();
  s = applyMsg(s, {
    t: "transcript.upsert",
    conv: { scope: "agent", mesh: "demo", agent: "router" },
    item: { id: "i1", kind: "message", role: "agent", text: "hi", ts: "T", complete: false },
  });
  expect((s.perMesh.demo.transcripts.router.items[0] as any).text).toBe("hi");
  s = applyMsg(s, {
    t: "transcript.patch",
    conv: { scope: "agent", mesh: "demo", agent: "router" },
    id: "i1",
    patch: { text: "hi there" },
  });
  expect((s.perMesh.demo.transcripts.router.items[0] as any).text).toBe("hi there");
});

test("transcript op on assistant conv targets the assistant transcript", () => {
  const s = applyMsg(seed(), {
    t: "transcript.upsert",
    conv: { scope: "assistant" },
    item: { id: "m1", kind: "message", role: "user", text: "go", ts: "T", complete: true },
  });
  expect((s.assistant.transcript[0] as any).text).toBe("go");
});

test("activity and mail append to lists", () => {
  let s = seed();
  s = applyMsg(s, { t: "activity", name: "demo", entry: { id: "a1", ts: "T", kind: "log", text: "hello" } });
  expect(s.perMesh.demo.activity).toHaveLength(1);
  s = applyMsg(s, { t: "mail", name: "demo", entry: { id: "ml1", ts: "T", from: "router", to: "codex-1", body: "x" } });
  expect(s.perMesh.demo.mail).toHaveLength(1);
});

test("agent.queue updates the per-agent queue summary", () => {
  const s = applyMsg(seed(), {
    t: "agent.queue",
    name: "demo",
    agent: "codex-1",
    summary: {
      count: 2,
      latestId: "q2",
      latestPreview: "mail: latest",
      items: [
        { id: "q1", source: "operator", from: "operator", to: "codex-1", preview: "you: review this", ts: "T1" },
        { id: "q2", source: "mail", from: "router", to: "codex-1", preview: "mail: latest", ts: "T2" },
      ],
    },
  });
  expect(s.perMesh.demo.queues["codex-1"]).toEqual({
    count: 2,
    latestId: "q2",
    latestPreview: "mail: latest",
    items: [
      { id: "q1", source: "operator", from: "operator", to: "codex-1", preview: "you: review this", ts: "T1" },
      { id: "q2", source: "mail", from: "router", to: "codex-1", preview: "mail: latest", ts: "T2" },
    ],
  });
});

test("agent.selfAwareness merges per-agent diagnostics", () => {
  let s = applyMsg(seed(), {
    t: "agent.selfAwareness",
    name: "demo",
    agent: "codex-1",
    selfAwareness: { nearLimit: { usagePercent: 0.9, ts: 1000 } },
  });
  s = applyMsg(s, {
    t: "agent.selfAwareness",
    name: "demo",
    agent: "codex-1",
    selfAwareness: { silentTaskCompletes: { count: 2, lastAt: 2000 } },
  });
  expect(s.perMesh.demo.selfAwareness["codex-1"]).toEqual({
    nearLimit: { usagePercent: 0.9, ts: 1000 },
    silentTaskCompletes: { count: 2, lastAt: 2000 },
  });
});

test("compact_done clears the agent's active health signal", () => {
  let s = applyMsg(seed(), {
    t: "agent.health",
    name: "demo",
    agent: "codex-1",
    health: { signal: "compacting", detail: { status: "compacting" }, ts: "T1" },
  });
  expect(s.perMesh.demo.health["codex-1"]?.signal).toBe("compacting");

  s = applyMsg(s, {
    t: "agent.health",
    name: "demo",
    agent: "codex-1",
    health: { signal: "compact_done", detail: { durationMs: 2200 }, ts: "T2" },
  });
  expect(s.perMesh.demo.health["codex-1"]).toBeUndefined();
});

test("permission add then remove updates pending + history", () => {
  let s = seed();
  s = applyMsg(s, {
    t: "permission.add",
    name: "demo",
    req: { requestId: "r1", agent: "codex-1", question: "run?", options: [{ id: "allow", name: "Allow" }], ts: "T" },
  });
  expect(s.perMesh.demo.pending).toHaveLength(1);
  s = applyMsg(s, {
    t: "permission.remove",
    name: "demo",
    resolved: { requestId: "r1", agent: "codex-1", optionId: "allow", by: "human", ts: "T" },
  });
  expect(s.perMesh.demo.pending).toHaveLength(0);
  expect(s.perMesh.demo.history).toHaveLength(1);
});

test("assistant.status updates", () => {
  const s = applyMsg(seed(), { t: "assistant.status", status: "absent" });
  expect(s.assistant.status).toBe("absent");
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function message(id: string): TranscriptItem {
  return { id, kind: "message", role: "agent", text: id, ts: "T", complete: true };
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("store notifies subscribers when harnesses changed", async () => {
  const store = createStore();
  let calls = 0;
  const unsub = store.subscribe(() => {
    calls += 1;
  });
  store.apply({ t: "harnesses-changed", harnessId: "codex" });
  await sleep(350);
  unsub();
  expect(calls).toBe(1);
});

test("store debounces repeated harness change notifications", async () => {
  const store = createStore();
  let calls = 0;
  const unsub = store.subscribe(() => {
    calls += 1;
  });
  store.apply({ t: "harnesses-changed", harnessId: "codex" });
  store.apply({ t: "harnesses-changed", harnessId: "claude" });
  store.apply({ t: "harnesses-changed", harnessId: "opencode" });
  await sleep(350);
  unsub();
  expect(calls).toBe(1);
});

test("listHarnesses retries transient failures and toasts only after retry exhaustion", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    Promise.resolve(new Response(JSON.stringify({ error: { message: "warming up" } }), { status: 503, headers: { "content-type": "application/json" } })),
    Promise.resolve(new Response(JSON.stringify({ error: { message: "still warming" } }), { status: 503, headers: { "content-type": "application/json" } })),
    Promise.resolve(new Response(JSON.stringify({ error: { message: "not ready" } }), { status: 503, headers: { "content-type": "application/json" } })),
  ];
  const fetchMock = mock(() => responses.shift()!);
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    await expect(store.listHarnesses()).rejects.toThrow("not ready");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.getToasts().filter((t) => t.kind === "error" && t.text.includes("list harnesses"))).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listHarnesses shares an in-flight request across repeated refresh triggers", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch: (res: Response) => void = () => {};
  const fetchMock = mock(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    const first = store.listHarnesses();
    const second = store.listHarnesses();
    resolveFetch(new Response(JSON.stringify([{ id: "codex", label: "Codex", installed: true }]), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await first).toHaveLength(1);
    expect(await second).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getToasts()).toHaveLength(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadOlderTranscript prepends older items and updates cursor metadata", async () => {
  const originalFetch = globalThis.fetch;
  const older = Array.from({ length: 100 }, (_, i) => message(`old-${i}`));
  const fetchMock = mock(() => Promise.resolve(responseJson({ items: older, hasMore: true })));
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    store.apply({
      t: "snapshot",
      state: {
        ...seed(),
        perMesh: {
          demo: {
            ...seed().perMesh.demo,
            transcripts: {
              "codex-1": { items: Array.from({ length: 100 }, (_, i) => message(`new-${i}`)), hasMore: true, oldestSeq: "new-0" },
            },
          },
        },
      },
    });

    await store.loadOlderTranscript("demo", "codex-1");

    const transcript = store.getState().perMesh.demo.transcripts["codex-1"];
    expect(fetchMock).toHaveBeenCalledWith("/api/meshes/demo/agents/codex-1/transcript?before=new-0&limit=100", { method: "GET", headers: {}, body: undefined });
    expect(transcript.items).toHaveLength(200);
    expect(transcript.items[0].id).toBe("old-0");
    expect(transcript.items[99].id).toBe("old-99");
    expect(transcript.items[100].id).toBe("new-0");
    expect(transcript.oldestSeq).toBe("old-0");
    expect(transcript.hasMore).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadInitialTranscript replaces placeholder items and updates cursor metadata", async () => {
  const originalFetch = globalThis.fetch;
  const tail = Array.from({ length: 100 }, (_, i) => message(`tail-${i}`));
  const fetchMock = mock(() => Promise.resolve(responseJson({ items: tail, hasMore: true })));
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    store.apply({
      t: "snapshot",
      state: {
        ...seed(),
        perMesh: {
          demo: {
            ...seed().perMesh.demo,
            transcripts: {
              "codex-1": { items: [], hasMore: true },
            },
          },
        },
      },
    });

    await store.loadInitialTranscript("demo", "codex-1");

    const transcript = store.getState().perMesh.demo.transcripts["codex-1"];
    expect(fetchMock).toHaveBeenCalledWith("/api/meshes/demo/agents/codex-1/transcript?limit=100", { method: "GET", headers: {}, body: undefined });
    expect(transcript.items).toHaveLength(100);
    expect(transcript.items[0].id).toBe("tail-0");
    expect(transcript.items[99].id).toBe("tail-99");
    expect(transcript.oldestSeq).toBe("tail-0");
    expect(transcript.hasMore).toBe(true);
    expect(store.isTranscriptInitialLoaded("demo", "codex-1")).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadInitialTranscript marks the transcript loaded before notifying subscribers", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(() => Promise.resolve(responseJson({ items: [message("tail-0")], hasMore: true })));
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    store.apply({
      t: "snapshot",
      state: {
        ...seed(),
        perMesh: {
          demo: {
            ...seed().perMesh.demo,
            transcripts: {
              "codex-1": { items: [], hasMore: true },
            },
          },
        },
      },
    });
    const observedLoaded: boolean[] = [];
    const unsub = store.subscribe(() => {
      observedLoaded.push(store.isTranscriptInitialLoaded("demo", "codex-1"));
    });

    await store.loadInitialTranscript("demo", "codex-1");
    unsub();

    expect(observedLoaded).toContain(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadInitialTranscript coalesces concurrent requests and skips after success", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch: (res: Response) => void = () => {};
  const fetchMock = mock(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    store.apply({
      t: "snapshot",
      state: {
        ...seed(),
        perMesh: {
          demo: {
            ...seed().perMesh.demo,
            transcripts: {
              "codex-1": { items: [], hasMore: true },
            },
          },
        },
      },
    });

    const first = store.loadInitialTranscript("demo", "codex-1");
    const second = store.loadInitialTranscript("demo", "codex-1");
    resolveFetch(responseJson({ items: [message("tail-0")], hasMore: true }));
    await Promise.all([first, second]);
    await store.loadInitialTranscript("demo", "codex-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const transcript = store.getState().perMesh.demo.transcripts["codex-1"];
    expect(transcript.items.map((item) => item.id)).toEqual(["tail-0"]);
    expect(transcript.hasMore).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadInitialTranscript fetches tail when live items arrived before initial load", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(() => Promise.resolve(responseJson({ items: [message("tail-0"), message("live-0")], hasMore: true })));
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    store.apply({
      t: "snapshot",
      state: {
        ...seed(),
        perMesh: {
          demo: {
            ...seed().perMesh.demo,
            transcripts: {
              "codex-1": { items: [message("live-0")], hasMore: true, oldestSeq: "live-0" },
            },
          },
        },
      },
    });

    await store.loadInitialTranscript("demo", "codex-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.isTranscriptInitialLoaded("demo", "codex-1")).toBe(true);
    expect(store.getState().perMesh.demo.transcripts["codex-1"].items.map((item) => item.id)).toEqual(["tail-0", "live-0"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadInitialTranscript keeps live items appended while fetch is in flight", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch: (res: Response) => void = () => {};
  const fetchMock = mock(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    store.apply({
      t: "snapshot",
      state: {
        ...seed(),
        perMesh: {
          demo: {
            ...seed().perMesh.demo,
            transcripts: {
              "codex-1": { items: [], hasMore: true },
            },
          },
        },
      },
    });

    const loading = store.loadInitialTranscript("demo", "codex-1");
    store.apply({
      t: "transcript.upsert",
      conv: { scope: "agent", mesh: "demo", agent: "codex-1" },
      item: message("live-after-fetch-start"),
    });
    resolveFetch(responseJson({ items: [message("tail-0")], hasMore: true }));
    await loading;

    const transcript = store.getState().perMesh.demo.transcripts["codex-1"];
    expect(transcript.items.map((item) => item.id)).toEqual(["tail-0", "live-after-fetch-start"]);
    expect(transcript.oldestSeq).toBe("tail-0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadOlderTranscript coalesces concurrent requests for the same agent", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch: (res: Response) => void = () => {};
  const fetchMock = mock(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    store.apply({
      t: "snapshot",
      state: {
        ...seed(),
        perMesh: {
          demo: {
            ...seed().perMesh.demo,
            transcripts: {
              "codex-1": { items: [message("new-0")], hasMore: true, oldestSeq: "new-0" },
            },
          },
        },
      },
    });

    const first = store.loadOlderTranscript("demo", "codex-1");
    const second = store.loadOlderTranscript("demo", "codex-1");
    resolveFetch(responseJson({ items: [message("old-0")], hasMore: false }));
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const transcript = store.getState().perMesh.demo.transcripts["codex-1"];
    expect(transcript.items.map((item) => item.id)).toEqual(["old-0", "new-0"]);
    expect(transcript.hasMore).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadOlderTranscript returns without fetching when there is no older transcript", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(() => Promise.resolve(responseJson({ items: [], hasMore: false })));
  globalThis.fetch = fetchMock as any;
  try {
    const store = createStore();
    store.apply({ t: "snapshot", state: seed() });

    await store.loadOlderTranscript("demo", "codex-1");

    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("events for an unknown mesh auto-create a perMesh container", () => {
  const s = applyMsg(emptyState(), { t: "activity", name: "ghost", entry: { id: "a1", ts: "T", kind: "log", text: "x" } });
  expect(s.perMesh.ghost.activity).toHaveLength(1);
});
