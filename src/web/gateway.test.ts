import { test, expect } from "bun:test";
import { MAX_SNAPSHOT_TRANSCRIPT_ITEMS, WebGateway } from "./gateway";
import { uploadPath } from "./uploads";
import type { MeshEvent, MeshConfig } from "../acp/types";

const CFG: MeshConfig = {
  name: "demo",
  agents: [
    { id: "router", harness: "claude", project: "p", role: "router" },
    { id: "codex-1", harness: "codex", project: "p", role: "member" },
  ],
  edges: [{ from: "router", to: "codex-1" }],
};

function fakeManager() {
  let listener: ((n: string, e: MeshEvent) => void) | null = null;
  const calls: any[] = [];
  let alive = true;
  let config: MeshConfig = structuredClone(CFG);
  return {
    calls,
    emit(n: string, e: MeshEvent) {
      listener?.(n, e);
    },
    on(l: any) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    listMeshes() {
      return alive ? [{ name: "demo", defined: true, status: "running" as const }] : [];
    },
    configOf() {
      return config;
    },
    async setAgentEffort(n: string, a: string, effort?: any) {
      calls.push(["setAgentEffort", n, a, effort]);
      config = { ...config, agents: config.agents.map((x) => (x.id === a ? { ...x, effort } : x)) };
    },
    routerOf() {
      return "router";
    },
    async startMesh(n: string) {
      calls.push(["start", n]);
    },
    async stopMesh(n: string) {
      calls.push(["stop", n]);
    },
    async promptRouter(n: string, t: string, images?: any[]) {
      calls.push(["promptRouter", n, t, images]);
    },
    promptAgent(n: string, a: string, t: string, images?: any[]) {
      calls.push(["promptAgent", n, a, t, images]);
    },
    removeQueuedTurn(n: string, a: string, turnId: string) {
      calls.push(["removeQueuedTurn", n, a, turnId]);
    },
    steerAgent(n: string, a: string, t: string, images?: any[]) {
      calls.push(["steerAgent", n, a, t, images]);
    },
    resolvePermission(n: string, r: string, o: string) {
      calls.push(["resolve", n, r, o]);
    },
    async setMode(n: string, a: string, m: string) {
      calls.push(["setMode", n, a, m]);
    },
    async setModel(n: string, a: string, m: string) {
      calls.push(["setModel", n, a, m]);
    },
    interruptAgent(n: string, a: string) {
      calls.push(["interrupt", n, a]);
    },
    async defineMesh(c: MeshConfig) {
      calls.push(["define", c.name]);
      config = structuredClone(c);
    },
    async deleteMesh(n: string) {
      calls.push(["delete", n]);
      alive = false;
    },
    async loadDefinitions() {
      calls.push(["reload"]);
    },
    async stopAll() {},
  };
}

function transcriptItems(gw: WebGateway, agent: string) {
  return gw.getOlderTranscriptItems("demo", agent, undefined, 1000)?.items ?? [];
}

test("snapshot includes meshes with composed agent rows", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const s = gw.snapshot();
  expect(s.meshes[0]).toMatchObject({ name: "demo", status: "running", router: "router" });
  expect(s.meshes[0].agents.map((a) => a.id)).toEqual(["router", "codex-1"]);
});

test("snapshot includes the gateway app version for client upgrade detection", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any, undefined, { appVersion: "build-2" });
  expect(gw.snapshot().appVersion).toBe("build-2");
});

test("update event folds into the agent transcript and broadcasts a transcript op", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg)); // first msg is snapshot
  m.emit("demo", {
    kind: "update",
    agent: "router",
    update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } } as any,
    ts: "T",
  });
  const up = got.find((x) => x.t === "transcript.upsert");
  expect(up.conv).toMatchObject({ scope: "agent", mesh: "demo", agent: "router" });
  expect(up.item).toMatchObject({ kind: "message", text: "hi" });
  expect((transcriptItems(gw, "router")[0] as any).text).toBe("hi");
});

test("initial replay folds transcript state without broadcasting transcript ops until replay ends", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  gw.beginInitialReplay("demo", "codex-1");
  m.emit("demo", {
    kind: "update",
    agent: "codex-1",
    update: { sessionUpdate: "agent_message_chunk", content: { text: "replayed history" } } as any,
    ts: "T1",
  });

  expect(transcriptItems(gw, "codex-1").some((i: any) => i.kind === "message" && i.text === "replayed history")).toBe(true);
  expect(got.some((x) => x.t === "transcript.upsert" && x.conv.agent === "codex-1")).toBe(false);

  gw.endInitialReplay("demo", "codex-1");
  m.emit("demo", {
    kind: "update",
    agent: "codex-1",
    update: { sessionUpdate: "agent_message_chunk", content: { text: " live" } } as any,
    ts: "T2",
  });

  expect(got.some((x) => x.t === "transcript.patch" && x.conv.agent === "codex-1")).toBe(true);
});

test("replay_started/replay_finished events drive transcript suppression end-to-end", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  // The control-plane brackets a loadSession history replay with these events; the gateway
  // must fold the flood into state but suppress the per-item fan-out to WS clients.
  m.emit("demo", { kind: "replay_started", agent: "codex-1", ts: "T0" });
  for (let i = 0; i < 5; i++) {
    m.emit("demo", {
      kind: "update",
      agent: "codex-1",
      update: { sessionUpdate: "agent_message_chunk", content: { text: `history ${i}` } } as any,
      ts: `T${i}`,
    });
  }

  // History reduced into state (chunks concatenate into the message), but zero transcript ops
  // fanned out during the replay window.
  expect(transcriptItems(gw, "codex-1").some((i: any) => i.kind === "message" && i.text?.includes("history 4"))).toBe(true);
  expect(got.some((x) => (x.t === "transcript.upsert" || x.t === "transcript.patch") && x.conv?.agent === "codex-1")).toBe(false);

  // After the replay ends, a live update fans out normally.
  m.emit("demo", { kind: "replay_finished", agent: "codex-1", ts: "T9" });
  m.emit("demo", {
    kind: "update",
    agent: "codex-1",
    update: { sessionUpdate: "user_message_chunk", content: { text: "live prompt" } } as any,
    ts: "T10",
  });
  expect(got.some((x) => x.t === "transcript.upsert" && x.conv.agent === "codex-1")).toBe(true);
});

test("normalized agent_usage aggregates per-agent usage and broadcasts it", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  m.emit("demo", { kind: "agent_usage", agent: "codex-1", used: 100, size: 2000, percent: 0.05, cost: 0.03, ts: "T1" } as any);
  m.emit("demo", { kind: "agent_usage", agent: "codex-1", used: 150, size: 2000, percent: 0.075, cost: 0.05, ts: "T2" } as any);

  const s = gw.snapshot();
  expect(s.perMesh.demo.usage["codex-1"]).toEqual({ used: 150, size: 2000, cost: 0.05, ts: "T2" });
  expect(s.perMesh.demo.transcripts["codex-1"]?.items ?? []).toHaveLength(0);
  expect(got.filter((x) => x.t === "agent.usage").at(-1)).toEqual({
    t: "agent.usage",
    name: "demo",
    agent: "codex-1",
    usage: { used: 150, size: 2000, cost: 0.05, ts: "T2" },
  });
});

test("raw usage_update frames are swallowed: no transcript item, no second denominator", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  // The harness's raw frame reports a 200K window; the gateway must NOT turn this into a
  // chip denominator (that's the control-plane's normalized agent_usage's job) and must
  // not let it leak into the transcript.
  m.emit("demo", {
    kind: "update",
    agent: "codex-1",
    update: { sessionUpdate: "usage_update", used: 230331, size: 200000, cost: 0.03 },
    ts: "T1",
  } as any);

  expect(gw.snapshot().perMesh.demo.usage["codex-1"]).toBeUndefined();
  expect(got.filter((x) => x.t === "agent.usage")).toHaveLength(0);
  expect(gw.snapshot().perMesh.demo.transcripts["codex-1"]?.items ?? []).toHaveLength(0);
});

test("board_snapshot folds the full board into per-mesh state and broadcasts t:\"board\"", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  const board = { mesh: "demo", revision: 2, epicSeq: 0, taskSeq: 1, epics: [], tasks: [{ id: 1, title: "t", status: "todo", priority: "normal", deps: [], subtasks: [], subtaskSeq: 0, revision: 1, createdBy: "alice", createdAt: "T", updatedAt: "T", comments: [], mailEventIds: [] }] };
  m.emit("demo", { kind: "board_snapshot", board, ts: "T1" } as any);

  expect(gw.snapshot().perMesh.demo.board).toEqual(board as any);
  const last = got.filter((x) => x.t === "board").at(-1);
  expect(last).toEqual({ t: "board", name: "demo", board: board as any });

  // a later snapshot fully replaces the folded copy (no deltas)
  const board2 = { ...board, revision: 3, tasks: [] };
  m.emit("demo", { kind: "board_snapshot", board: board2, ts: "T2" } as any);
  expect(gw.snapshot().perMesh.demo.board?.revision).toBe(3);
  expect(gw.snapshot().perMesh.demo.board?.tasks).toHaveLength(0);
});

test("the chip denominator follows the normalized event, not the raw usage_update.size", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  // Raw frame would suggest a 200K window (115% over); normalized event carries the real 1M.
  m.emit("demo", {
    kind: "update",
    agent: "codex-1",
    update: { sessionUpdate: "usage_update", used: 230331, size: 200000 },
    ts: "T1",
  } as any);
  m.emit("demo", { kind: "agent_usage", agent: "codex-1", used: 230331, size: 1_000_000, percent: 0.23, ts: "T2" } as any);

  const usage = gw.snapshot().perMesh.demo.usage["codex-1"];
  expect(usage).toEqual({ used: 230331, size: 1_000_000, ts: "T2" });
  expect(got.filter((x) => x.t === "agent.usage").at(-1)?.usage.size).toBe(1_000_000);
});

test("compact events fold into transcript and activity", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  m.emit("demo", { kind: "compact_started", agent: "codex-1", reason: "auto-threshold", ts: 1000 } as any);
  m.emit("demo", { kind: "compact_completed", agent: "codex-1", ts: 2000 } as any);

  const items = transcriptItems(gw, "codex-1");
  expect(items.filter((i: any) => i.kind === "compact")).toHaveLength(2);
  expect(items[0]).toMatchObject({ kind: "compact", status: "started", reason: "auto-threshold" });
  expect(got.some((x) => x.t === "transcript.upsert" && x.item.kind === "compact")).toBe(true);
  expect(got.some((x) => x.t === "activity" && x.entry.kind === "compact")).toBe(true);
});

test("snapshot omits agent transcript items and advertises lazy backfill", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);

  for (let i = 0; i < MAX_SNAPSHOT_TRANSCRIPT_ITEMS + 20; i++) {
    m.emit("demo", { kind: "compact_started", agent: "codex-1", reason: `r${i}`, ts: 1000 + i } as any);
  }

  const transcript = gw.snapshot().perMesh.demo.transcripts["codex-1"];
  expect(MAX_SNAPSHOT_TRANSCRIPT_ITEMS).toBe(0);
  expect(transcript.items).toHaveLength(0);
  expect(transcript.hasMore).toBe(true);
  expect(transcript.oldestSeq).toBeUndefined();
});

test("snapshot includes placeholder transcript wrappers for every configured agent", () => {
  const m = fakeManager();
  const cfg: MeshConfig = {
    ...CFG,
    agents: [
      { id: "router", harness: "claude", project: "p", role: "router" },
      { id: "builder", harness: "codex", project: "p", role: "member" },
      { id: "reviewer", harness: "claude", project: "p", role: "member" },
      { id: "fixer", harness: "codex", project: "p", role: "member" },
      { id: "reserve", harness: "opencode", project: "p", role: "member" },
    ],
    edges: [],
  };
  m.defineMesh(cfg);
  const gw = new WebGateway(m as any);

  m.emit("demo", { kind: "compact_started", agent: "router", reason: "has-history", ts: 1000 } as any);

  const transcripts = gw.snapshot().perMesh.demo.transcripts;
  expect(Object.keys(transcripts).sort()).toEqual(["builder", "fixer", "reserve", "reviewer", "router"]);
  expect(transcripts.router.items).toHaveLength(0);
  expect(transcripts.router.hasMore).toBe(true);
  for (const agent of ["builder", "reviewer", "fixer", "reserve"]) {
    expect(transcripts[agent].items).toHaveLength(0);
    expect(transcripts[agent].hasMore).toBe(true);
    expect(transcripts[agent].oldestSeq).toBeUndefined();
  }
});

test("near-limit and silent-stop events update self-awareness state", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  m.emit("demo", { kind: "near_context_limit_no_compact", agent: "codex-1", usagePercent: 0.9, ts: 1000 } as any);
  m.emit("demo", { kind: "silent_task_complete", agent: "codex-1", turnId: "t1", ts: 2000 } as any);

  const self = gw.snapshot().perMesh.demo.selfAwareness["codex-1"];
  expect(self.nearLimit).toEqual({ usagePercent: 0.9, ts: 1000 });
  expect(self.silentTaskCompletes).toEqual({ count: 1, lastAt: 2000 });
  expect(got.some((x) => x.t === "agent.selfAwareness" && x.agent === "codex-1")).toBe(true);
  expect(got.some((x) => x.t === "activity" && x.entry.kind === "warning")).toBe(true);
});


test("effort config option updates are exposed in snapshot and ws", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  m.emit("demo", {
    kind: "update",
    agent: "router",
    update: {
      sessionUpdate: "session_config_update",
      configOption: {
        category: "effort",
        id: "thought_level",
        currentValue: "medium",
        options: [{ value: "low", name: "Low" }, { value: "max", name: "Max" }],
      },
    } as any,
    ts: "T",
  });

  expect(gw.snapshot().perMesh.demo.efforts.router).toEqual({
    configId: "thought_level",
    current: "medium",
    available: [{ id: "low", name: "Low" }, { id: "max", name: "Max" }],
  });
  expect(got.find((x) => x.t === "agent.efforts")).toEqual({
    t: "agent.efforts",
    name: "demo",
    agent: "router",
    configId: "thought_level",
    current: "medium",
    available: [{ id: "low", name: "Low" }, { id: "max", name: "Max" }],
  });
});

test("agent health signal is exposed in snapshot and ws without transcript folding", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  m.emit("demo", {
    kind: "agent_health_signal",
    agent: "router",
    signal: "retrying",
    detail: { attempt: 1, retryDelayMs: 5000, reason: "rate_limit" },
    ts: "T",
  } as any);

  const s = gw.snapshot();
  expect(s.perMesh.demo.health.router).toEqual({
    signal: "retrying",
    detail: { attempt: 1, retryDelayMs: 5000, reason: "rate_limit" },
    turn: undefined,
    ts: "T",
  });
  expect(s.perMesh.demo.transcripts.router?.items ?? []).toHaveLength(0);
  expect(got.find((x) => x.t === "agent.health")).toEqual({
    t: "agent.health",
    name: "demo",
    agent: "router",
    health: {
      signal: "retrying",
      detail: { attempt: 1, retryDelayMs: 5000, reason: "rate_limit" },
      turn: undefined,
      ts: "T",
    },
  });
});

test("a quiet-turn health warning surfaces as an activity entry (and is not a transcript/failure)", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  m.emit("demo", {
    kind: "agent_turn_health",
    agent: "codex-1",
    turn: { id: "t1", agent: "codex-1", source: "operator" },
    level: "warning",
    reason: "first_signal_timeout",
    detail: "quiet for 120s with no output",
    ts: "T",
  } as any);

  const s = gw.snapshot();
  const entry = s.perMesh.demo.activity.find((a) => a.text.includes("codex-1") && a.text.includes("quiet"));
  expect(entry).toBeTruthy();
  expect(s.perMesh.demo.transcripts["codex-1"]?.items ?? []).toHaveLength(0);
  expect(got.some((x) => x.t === "activity" && x.entry.text.includes("quiet"))).toBe(true);
});

test("permission add then resolved updates pending + history + activity", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", {
    kind: "permission",
    agent: "codex-1",
    requestId: "r1",
    question: "run?",
    options: [{ id: "allow", name: "Allow" }],
    ts: "T",
  });
  expect(gw.snapshot().perMesh.demo.pending).toHaveLength(1);
  expect(got.some((x) => x.t === "permission.add")).toBe(true);
  m.emit("demo", {
    kind: "permission_resolved",
    agent: "codex-1",
    requestId: "r1",
    optionId: "allow",
    by: "human",
    ts: "T",
  });
  const s = gw.snapshot();
  expect(s.perMesh.demo.pending).toHaveLength(0);
  expect(s.perMesh.demo.history).toHaveLength(1);
  expect(s.perMesh.demo.activity.some((a) => a.kind === "permission_resolved")).toBe(true);
});

test("mail event emits both activity and mail entries without folding into transcript yet", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", { kind: "mail", from: "router", to: "codex-1", body: "ping", ts: "T" });
  const s = gw.snapshot();
  expect(s.perMesh.demo.mail).toHaveLength(1);
  expect(s.perMesh.demo.activity.some((a) => a.kind === "mail")).toBe(true);
  expect(got.some((x) => x.t === "mail")).toBe(true);
  expect(got.some((x) => x.t === "activity")).toBe(true);
  expect(got.some((x) => x.t === "transcript.upsert" && x.conv.scope === "agent" && x.conv.agent === "codex-1" && x.item.kind === "mail")).toBe(false);
  expect((s.perMesh.demo.transcripts["codex-1"]?.items ?? []).some((i: any) => i.kind === "mail" && i.from === "router")).toBe(false);
});

test("mail events carrying a durable id are deduplicated across snapshot replays", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", { kind: "mail", id: "durable-1", from: "router", to: "codex-1", body: "ping", ts: "T" } as any);
  m.emit("demo", { kind: "mail", id: "durable-1", from: "router", to: "codex-1", body: "ping", ts: "T" } as any);
  const s = gw.snapshot();
  expect(s.perMesh.demo.mail).toHaveLength(1);
  expect(s.perMesh.demo.mail[0].id).toBe("durable-1");
  expect(got.filter((x) => x.t === "mail").length).toBe(1);
  expect(s.perMesh.demo.activity.filter((a) => a.kind === "mail")).toHaveLength(1);
});

test("steer event emits a visible activity entry", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", { kind: "steer", from: "operator", to: "codex-1", body: "change course", ts: "T" });
  const s = gw.snapshot();
  expect(s.perMesh.demo.activity.some((a) => a.kind === "steer" && a.text.includes("change course"))).toBe(true);
  expect(got.some((x) => x.t === "activity" && x.entry.kind === "steer")).toBe(true);
});

test("steerAgent delegates to the manager without immediate transcript echo", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  gw.steerAgent("demo", "codex-1", "urgent");
  expect(m.calls).toContainEqual(["steerAgent", "demo", "codex-1", "urgent", []]);
  expect(transcriptItems(gw, "codex-1")).toHaveLength(0);
});

test("turn queued updates queue summary and turn started folds into transcript", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "turn-1", agent: "codex-1", source: "operator", text: "please review **this**", preview: "you: please review this", ts: "T" },
    ts: "T",
  } as any);
  let s = gw.snapshot();
  expect(s.perMesh.demo.queues["codex-1"]).toMatchObject({ count: 1, latestPreview: "you: please review this" });
  expect(s.perMesh.demo.transcripts["codex-1"]?.items ?? []).toHaveLength(0);
  expect(got.some((x) => x.t === "agent.queue" && x.agent === "codex-1" && x.summary.count === 1)).toBe(true);

  m.emit("demo", {
    kind: "agent_turn",
    phase: "started",
    turn: { id: "turn-1", agent: "codex-1", source: "operator", text: "please review **this**", preview: "you: please review this", ts: "T" },
    ts: "T2",
  } as any);
  s = gw.snapshot();
  expect(s.perMesh.demo.queues["codex-1"]?.count ?? 0).toBe(0);
  expect(transcriptItems(gw, "codex-1").some((i: any) => i.kind === "message" && i.role === "user" && i.text === "please review **this**")).toBe(true);
});

test("queue summary includes browsable items with source metadata in queue order", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));

  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "turn-1", agent: "codex-1", source: "operator", from: "operator", to: "codex-1", text: "first", preview: "you: first", ts: "T1", images: [{ id: "img", mimeType: "image/png", name: "x.png", path: "/secret" }] },
    ts: "T1",
  } as any);
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "turn-2", agent: "codex-1", source: "mail", from: "router", to: "codex-1", text: "second", preview: "router: second", ts: "T2", mailId: "mail-2" },
    ts: "T2",
  } as any);

  const q = gw.snapshot().perMesh.demo.queues["codex-1"];
  expect(q.count).toBe(2);
  expect(q.latestId).toBe("turn-2");
  expect(q.latestPreview).toBe("router: second");
  expect(q.items).toEqual([
    { id: "turn-1", source: "operator", from: "operator", to: "codex-1", preview: "you: first", ts: "T1" },
    { id: "turn-2", source: "mail", from: "router", to: "codex-1", preview: "router: second", ts: "T2" },
  ]);
  expect("text" in q.items![0]).toBe(false);
  expect("images" in q.items![0]).toBe(false);
  expect("mailId" in q.items![1]).toBe(false);
  expect(got.filter((x) => x.t === "agent.queue").at(-1).summary.items).toEqual(q.items);
});

test("queue summary mirrors steer priority and caps item payload", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);

  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "normal-1", agent: "codex-1", source: "operator", from: "operator", to: "codex-1", text: "normal", preview: "you: normal", ts: "T1" },
    ts: "T1",
  } as any);
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "steer-1", agent: "codex-1", source: "steer", from: "operator", to: "codex-1", text: "urgent", preview: "you: urgent", ts: "T2" },
    ts: "T2",
  } as any);
  let q = gw.snapshot().perMesh.demo.queues["codex-1"];
  expect(q.items?.map((item) => item.id)).toEqual(["steer-1", "normal-1"]);
  expect(q.latestId).toBe("steer-1");
  expect(q.latestPreview).toBe("you: urgent");

  for (let i = 0; i < 55; i++) {
    m.emit("demo", {
      kind: "agent_turn",
      phase: "queued",
      turn: { id: `normal-${i + 2}`, agent: "codex-1", source: "operator", from: "operator", to: "codex-1", text: `normal ${i}`, preview: `you: normal ${i}`, ts: `T${i + 3}` },
      ts: `T${i + 3}`,
    } as any);
  }

  q = gw.snapshot().perMesh.demo.queues["codex-1"];
  expect(q.count).toBe(57);
  expect(q.items).toHaveLength(50);
  expect(q.items?.at(-1)?.id).toBe("normal-56");
});

test("queue summary cap keeps a latest steer even when it is outside the tail window", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);

  for (let i = 0; i < 55; i++) {
    m.emit("demo", {
      kind: "agent_turn",
      phase: "queued",
      turn: { id: `normal-${i}`, agent: "codex-1", source: "operator", from: "operator", to: "codex-1", text: `normal ${i}`, preview: `you: normal ${i}`, ts: `T${String(i).padStart(2, "0")}` },
      ts: `T${String(i).padStart(2, "0")}`,
    } as any);
  }
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "latest-steer", agent: "codex-1", source: "steer", from: "operator", to: "codex-1", text: "urgent", preview: "you: urgent", ts: "T99" },
    ts: "T99",
  } as any);

  const q = gw.snapshot().perMesh.demo.queues["codex-1"];
  expect(q.count).toBe(56);
  expect(q.latestId).toBe("latest-steer");
  expect(q.items).toHaveLength(50);
  expect(q.items?.[0]).toMatchObject({ id: "latest-steer", source: "steer" });
});

test("dead agent status clears its queue summary", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "turn-1", agent: "codex-1", source: "operator", text: "queued work", preview: "you: queued work", ts: "T" },
    ts: "T",
  } as any);
  expect(gw.snapshot().perMesh.demo.queues["codex-1"]).toMatchObject({ count: 1, latestPreview: "you: queued work" });

  m.emit("demo", { kind: "agent_status", agent: "codex-1", status: "dead", detail: "exit 9", ts: "T2" });

  expect(gw.snapshot().perMesh.demo.queues["codex-1"]).toMatchObject({ count: 0, latestPreview: undefined });
  expect(got.some((x) => x.t === "agent.queue" && x.agent === "codex-1" && x.summary.count === 0)).toBe(true);
});

test("mail turn started folds a sender-labeled mail item", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "mail-1", agent: "codex-1", source: "mail", from: "router", to: "codex-1", text: "ping", preview: "router: ping", ts: "T" },
    ts: "T",
  } as any);
  m.emit("demo", {
    kind: "agent_turn",
    phase: "started",
    turn: { id: "mail-1", agent: "codex-1", source: "mail", from: "router", to: "codex-1", text: "ping", preview: "router: ping", ts: "T" },
    ts: "T2",
  } as any);
  expect(transcriptItems(gw, "codex-1").some((i: any) => i.kind === "mail" && i.from === "router" && i.body === "ping")).toBe(true);
});

test("mail turn consumed clears the queue and folds the mail as read context", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  const turn = { id: "mail-1", agent: "codex-1", source: "mail", from: "router", to: "codex-1", text: "ping", preview: "router: ping", ts: "T", mailId: "m-1" };
  m.emit("demo", { kind: "agent_turn", phase: "queued", turn, ts: "T" } as any);
  expect(gw.snapshot().perMesh.demo.queues["codex-1"]).toMatchObject({ count: 1 });

  m.emit("demo", { kind: "agent_turn", phase: "consumed", turn, ts: "T2" } as any);
  const s = gw.snapshot();
  expect(s.perMesh.demo.queues["codex-1"]?.count ?? 0).toBe(0);
  expect(got.some((x) => x.t === "agent.queue" && x.agent === "codex-1" && x.summary.count === 0)).toBe(true);
  // The mail entered the agent's context via check_mail, so it must appear in the transcript exactly once.
  expect(transcriptItems(gw, "codex-1").filter((i: any) => i.kind === "mail" && i.from === "router" && i.body === "ping")).toHaveLength(1);
});

test("removeQueuedTurn delegates only for queued operator turns", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "user-1", agent: "codex-1", source: "operator", from: "operator", to: "codex-1", text: "later", preview: "you: later", ts: "T1" },
    ts: "T1",
  } as any);
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "mail-1", agent: "codex-1", source: "mail", from: "router", to: "codex-1", text: "ping", preview: "router: ping", ts: "T2" },
    ts: "T2",
  } as any);
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "operator-steer-1", agent: "codex-1", source: "steer", from: "operator", to: "codex-1", text: "urgent", preview: "you: urgent", ts: "T3" },
    ts: "T3",
  } as any);
  m.emit("demo", {
    kind: "agent_turn",
    phase: "queued",
    turn: { id: "peer-steer-1", agent: "codex-1", source: "steer", from: "router", to: "codex-1", text: "urgent mail", preview: "router: urgent mail", ts: "T4" },
    ts: "T4",
  } as any);

  gw.removeQueuedTurn("demo", "codex-1", "user-1");
  expect(m.calls).toContainEqual(["removeQueuedTurn", "demo", "codex-1", "user-1"]);
  gw.removeQueuedTurn("demo", "codex-1", "operator-steer-1");
  expect(m.calls).toContainEqual(["removeQueuedTurn", "demo", "codex-1", "operator-steer-1"]);
  expect(() => gw.removeQueuedTurn("demo", "codex-1", "mail-1")).toThrow(/only user queued messages/i);
  expect(() => gw.removeQueuedTurn("demo", "codex-1", "peer-steer-1")).toThrow(/only user queued messages/i);
});

test("removed queue events clear the summary without adding transcript items", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const turn = { id: "user-1", agent: "codex-1", source: "operator", from: "operator", to: "codex-1", text: "later", preview: "you: later", ts: "T1" };
  m.emit("demo", { kind: "agent_turn", phase: "queued", turn, ts: "T1" } as any);
  m.emit("demo", { kind: "agent_turn", phase: "removed", turn, ts: "T2" } as any);

  const s = gw.snapshot();
  expect(s.perMesh.demo.queues["codex-1"]?.count ?? 0).toBe(0);
  expect(s.perMesh.demo.transcripts["codex-1"]?.items ?? []).toHaveLength(0);
});

test("a current_mode_update syncs the mode picker + broadcasts (claude has no echo)", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", { kind: "agent_modes", agent: "router", current: "default", available: [{ id: "default", name: "default" }, { id: "plan", name: "plan" }], ts: "T" });
  m.emit("demo", { kind: "update", agent: "router", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" }, ts: "T" });
  expect(gw.snapshot().perMesh.demo.modes.router.current).toBe("plan");
  expect(got.some((x) => x.t === "agent.modes" && x.agent === "router" && x.current === "plan")).toBe(true);
});

test("agent_models updates gateway state, summary, and broadcasts", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", {
    kind: "agent_models",
    agent: "codex-1",
    current: "kimi-k2",
    available: [{ id: "kimi-k2", name: "kimi-k2" }, { id: "deepseek-v3", name: "deepseek-v3" }],
    ts: "T",
  });
  expect(gw.snapshot().perMesh.demo.models["codex-1"].current).toBe("kimi-k2");
  expect(gw.snapshot().meshes[0].agents.find((a) => a.id === "codex-1")?.model?.current).toBe("kimi-k2");
  expect(got).toContainEqual({
    t: "agent.models",
    name: "demo",
    agent: "codex-1",
    current: "kimi-k2",
    available: [{ id: "kimi-k2", name: "kimi-k2" }, { id: "deepseek-v3", name: "deepseek-v3" }],
  });
});

test("config_option_update syncs model picker state and broadcasts", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", {
    kind: "update",
    agent: "codex-1",
    update: {
      sessionUpdate: "config_option_update",
      option: {
        category: "model",
        currentValue: "gpt-5.4",
        options: [
          { value: "gpt-5.4", name: "GPT 5.4" },
          { value: "gpt-5.5", name: "GPT 5.5" },
        ],
      },
    },
    ts: "T",
  } as any);

  expect(gw.snapshot().perMesh.demo.models["codex-1"].current).toBe("gpt-5.4");
  expect(got).toContainEqual({
    t: "agent.models",
    name: "demo",
    agent: "codex-1",
    current: "gpt-5.4",
    available: [{ id: "gpt-5.4", name: "GPT 5.4" }, { id: "gpt-5.5", name: "GPT 5.5" }],
  });
});

test("setEffort persists the effort into the summary and broadcasts mesh.list (no restart)", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  await gw.setEffort("demo", "codex-1", "high");
  expect(m.calls).toContainEqual(["setAgentEffort", "demo", "codex-1", "high"]);
  const summary = gw.snapshot().meshes.find((x) => x.name === "demo");
  expect(summary?.agents.find((a) => a.id === "codex-1")?.effort).toBe("high");
  expect(got.some((x) => x.t === "mesh.list")).toBe(true);
});

test("command methods delegate to the manager", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  await gw.startMesh("demo");
  await gw.promptRouter("demo", "go");
  gw.steerAgent("demo", "codex-1", "urgent");
  gw.resolvePermission("demo", "r1", "allow");
  await gw.setModel("demo", "codex-1", "deepseek-v3");
  expect(m.calls).toContainEqual(["start", "demo"]);
  expect(m.calls).toContainEqual(["promptRouter", "demo", "go", []]);
  expect(m.calls).toContainEqual(["steerAgent", "demo", "codex-1", "urgent", []]);
  expect(m.calls).toContainEqual(["resolve", "demo", "r1", "allow"]);
  expect(m.calls).toContainEqual(["setModel", "demo", "codex-1", "deepseek-v3"]);
});

test("promptRouter delegates without immediate user message echo", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  await gw.promptRouter("demo", "hello");
  const tr = gw.snapshot().perMesh.demo.transcripts.router;
  expect(tr.items).toHaveLength(0);
});

test("promptRouter threads images to manager without exposing private image fields", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any, undefined, { root: "/tmp/root" });
  await gw.promptRouter("demo", "see", [{ id: "abc.png", mimeType: "image/png", name: "abc.png" }]);
  expect(m.calls[m.calls.length - 1][0]).toBe("promptRouter");
  expect(m.calls[m.calls.length - 1][3][0]).toMatchObject({ id: "abc.png", bucket: "demo", url: "/api/uploads/demo/abc.png" });
});

test("promptRouter ignores a client-supplied image path/bucket/url (no arbitrary file read)", async () => {
  const m = fakeManager();
  const root = "/tmp/root";
  const gw = new WebGateway(m as any, undefined, { root });
  // a malicious client tries to smuggle an absolute path + foreign bucket + url
  await gw.promptRouter("demo", "see", [
    { id: "abc.png", mimeType: "image/png", name: "x", path: "/etc/passwd", bucket: "../../etc", url: "http://evil/x" } as any,
  ]);
  const ref = m.calls[m.calls.length - 1][3][0];
  // path is reconstructed server-side from the configured root + server-chosen bucket + validated id
  expect(ref.path).toBe(uploadPath(root, "demo", "abc.png"));
  expect(ref.bucket).toBe("demo");
  expect(ref.url).toBe("/api/uploads/demo/abc.png");
});

test("promptRouter drops an image with a malformed id (no path → skipped, not read off disk)", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any, undefined, { root: "/tmp/root" });
  await gw.promptRouter("demo", "see", [{ id: "../../../etc/passwd", mimeType: "image/png", name: "x" } as any]);
  const ref = m.calls[m.calls.length - 1][3][0];
  expect(ref.path).toBeUndefined();
  expect(ref.url).toBeUndefined();
});

test("agent_capabilities updates gateway state and broadcasts", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", { kind: "agent_capabilities", agent: "router", image: true, ts: "T" });
  expect(gw.snapshot().perMesh.demo.capabilities.router.image).toBe(true);
  expect(got).toContainEqual({ t: "agent.capabilities", name: "demo", agent: "router", image: true });
});

test("agent_status updates the mesh summary agent row", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  m.emit("demo", { kind: "agent_status", agent: "codex-1", status: "ready", ts: "T" });
  const row = gw.snapshot().meshes[0].agents.find((a) => a.id === "codex-1");
  expect(row?.status).toBe("ready");
});

test("agent_activity updates the mesh summary agent row and broadcasts", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", { kind: "agent_activity", agent: "codex-1", activity: "working", ts: "T" });
  const row = gw.snapshot().meshes[0].agents.find((a) => a.id === "codex-1");
  expect(row?.activity).toBe("working");
  expect(got).toContainEqual({ t: "agent.activity", name: "demo", agent: "codex-1", activity: "working" });
});

test("promptAssistant throws when no assistant is configured", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  expect(gw.snapshot().assistant.status).toBe("absent");
  expect(gw.promptAssistant("hi")).rejects.toThrow();
});

test("deleteMesh delegates and prunes perMesh state", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  m.emit("demo", { kind: "log", text: "hi", ts: "T" }); // seed perMesh
  expect(gw.snapshot().perMesh.demo).toBeDefined();
  await gw.deleteMesh("demo");
  expect(m.calls).toContainEqual(["delete", "demo"]);
  expect(gw.snapshot().perMesh.demo).toBeUndefined();
});

test("attachment_published folds an attachment card into the publishing agent's transcript", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", {
    kind: "attachment_published",
    agent: "codex-1",
    path: "out/chart.png",
    caption: "the chart",
    name: "Chart",
    contentType: "image/png",
    ts: "T1",
  });
  const items = transcriptItems(gw, "codex-1");
  const card = items.find((it: any) => it.kind === "attachment") as any;
  expect(card).toMatchObject({
    kind: "attachment",
    agent: "codex-1",
    path: "out/chart.png",
    caption: "the chart",
    name: "Chart",
    contentType: "image/png",
  });
  // The card carries everything the web layer needs to build the mesh-scoped artifact URL
  // (/api/meshes/demo/agents/codex-1/artifacts/out/chart.png) exactly.
  expect(got.some((msg) => msg.t === "transcript.upsert" && msg.item.kind === "attachment")).toBe(true);
});

test("re-ingesting the same attachment_published (snapshot reattach) does not duplicate the card", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const ev = {
    kind: "attachment_published" as const,
    agent: "codex-1",
    path: "report.md",
    contentType: "text/markdown; charset=utf-8",
    ts: "T1",
  };
  m.emit("demo", ev);
  m.emit("demo", ev); // snapshotEvents() replays it on every backend reattach
  const items = transcriptItems(gw, "codex-1");
  expect(items.filter((it: any) => it.kind === "attachment")).toHaveLength(1);
});

test("distinct publishes (distinct ts) yield distinct attachment cards", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  m.emit("demo", { kind: "attachment_published", agent: "codex-1", path: "report.md", contentType: "text/markdown", ts: "T1" });
  m.emit("demo", { kind: "attachment_published", agent: "codex-1", path: "report.md", contentType: "text/markdown", ts: "T2" });
  const items = transcriptItems(gw, "codex-1");
  expect(items.filter((it: any) => it.kind === "attachment")).toHaveLength(2);
});

// ── Step 7.4-C — notification center (in-memory; no root) ─────────────────────────
test("emitNotification broadcasts notification.add + folds into the snapshot", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const seen: any[] = [];
  const unsub = gw.subscribe((msg) => seen.push(msg));
  await gw.emitNotification({ type: "system-alert", severity: "warning", title: "auto-compact", dedupKey: "system:compact:demo" });
  const add = seen.find((x) => x.t === "notification.add");
  expect(add).toBeTruthy();
  expect(add.item.title).toBe("auto-compact");
  expect(add.unreadCount).toBe(1);
  expect(gw.snapshot().notifications?.items[0].title).toBe("auto-compact");
  expect(gw.snapshot().notifications?.unreadCount).toBe(1);
  unsub();
});

test("emitNotification dedup: same key idempotent → no second add, no re-nag", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  await gw.emitNotification({ type: "harness-upgrade", title: "codex v1.2.5", dedupKey: "harness-upgrade:codex:1.2.5" });
  await gw.markAllNotificationsRead();
  const seen: any[] = [];
  const unsub = gw.subscribe((msg) => seen.push(msg));
  await gw.emitNotification({ type: "harness-upgrade", title: "codex v1.2.5", dedupKey: "harness-upgrade:codex:1.2.5" });
  expect(seen.some((x) => x.t === "notification.add")).toBe(false); // idempotent — no duplicate, no re-surface
  expect(gw.snapshot().notifications?.unreadCount).toBe(0);
  unsub();
});

test("markNotificationRead broadcasts notification.update; markAll → unread 0", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  await gw.emitNotification({ type: "device-auth", title: "new device", dedupKey: "device-auth:dev-x" });
  const id = gw.listNotifications().items[0].id;
  const seen: any[] = [];
  const unsub = gw.subscribe((msg) => seen.push(msg));
  await gw.markNotificationRead(id);
  const upd = seen.find((x) => x.t === "notification.update");
  expect(upd?.id).toBe(id);
  expect(upd?.patch.readAt).toBeTruthy();
  expect(upd?.unreadCount).toBe(0);
  unsub();
});
