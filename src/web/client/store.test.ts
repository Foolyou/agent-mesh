import { test, expect } from "bun:test";
import { emptyState, applyMsg, createStore } from "./store";
import type { GatewayState } from "../types";

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
      demo: { config: { name: "demo", agents: [], edges: [] }, transcripts: {}, activity: [], mail: [], pending: [], history: [], modes: {}, models: {}, capabilities: {}, usage: {}, health: {}, queues: {} },
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

test("transcript.upsert then patch on an agent conv", () => {
  let s = seed();
  s = applyMsg(s, {
    t: "transcript.upsert",
    conv: { scope: "agent", mesh: "demo", agent: "router" },
    item: { id: "i1", kind: "message", role: "agent", text: "hi", ts: "T", complete: false },
  });
  expect((s.perMesh.demo.transcripts.router[0] as any).text).toBe("hi");
  s = applyMsg(s, {
    t: "transcript.patch",
    conv: { scope: "agent", mesh: "demo", agent: "router" },
    id: "i1",
    patch: { text: "hi there" },
  });
  expect((s.perMesh.demo.transcripts.router[0] as any).text).toBe("hi there");
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

test("events for an unknown mesh auto-create a perMesh container", () => {
  const s = applyMsg(emptyState(), { t: "activity", name: "ghost", entry: { id: "a1", ts: "T", kind: "log", text: "x" } });
  expect(s.perMesh.ghost.activity).toHaveLength(1);
});
