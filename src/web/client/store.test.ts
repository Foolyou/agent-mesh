import { test, expect } from "bun:test";
import { emptyState, applyMsg } from "./store";
import type { GatewayState } from "../types";

function seed(): GatewayState {
  return {
    meshes: [
      {
        name: "demo",
        defined: true,
        status: "running",
        router: "router",
        agents: [
          { id: "router", harness: "claude", role: "router", status: "ready" },
          { id: "codex-1", harness: "codex", role: "member", status: "spawning" },
        ],
        edges: [["router", "codex-1"]],
      },
    ],
    master: { status: "ready", transcript: [] },
    perMesh: {
      demo: { config: { name: "demo", agents: [], edges: [] }, transcripts: {}, activity: [], mail: [], pending: [], history: [], modes: {}, capabilities: {} },
    },
  };
}

test("snapshot replaces state", () => {
  const s = applyMsg(emptyState(), { t: "snapshot", state: seed() });
  expect(s.meshes[0].name).toBe("demo");
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

test("transcript op on master conv targets the master transcript", () => {
  const s = applyMsg(seed(), {
    t: "transcript.upsert",
    conv: { scope: "master" },
    item: { id: "m1", kind: "message", role: "user", text: "go", ts: "T", complete: true },
  });
  expect((s.master.transcript[0] as any).text).toBe("go");
});

test("activity and mail append to lists", () => {
  let s = seed();
  s = applyMsg(s, { t: "activity", name: "demo", entry: { id: "a1", ts: "T", kind: "log", text: "hello" } });
  expect(s.perMesh.demo.activity).toHaveLength(1);
  s = applyMsg(s, { t: "mail", name: "demo", entry: { id: "ml1", ts: "T", from: "router", to: "codex-1", body: "x" } });
  expect(s.perMesh.demo.mail).toHaveLength(1);
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

test("master.status updates", () => {
  const s = applyMsg(seed(), { t: "master.status", status: "absent" });
  expect(s.master.status).toBe("absent");
});

test("events for an unknown mesh auto-create a perMesh container", () => {
  const s = applyMsg(emptyState(), { t: "activity", name: "ghost", entry: { id: "a1", ts: "T", kind: "log", text: "x" } });
  expect(s.perMesh.ghost.activity).toHaveLength(1);
});
