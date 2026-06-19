// src/mesh-host.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshHostDaemon, type BridgeControlPlane } from "./mesh-host";
import { MeshHostClient } from "./mesh-host-client";
import { meshSocketPath } from "./mesh-socket";
import { LineBuffer, encodeFrame, PROTO_VERSION } from "./protocol";
import type { MeshConfig, MeshEvent } from "./acp/types";

let dir: string;
let daemon: MeshHostDaemon | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "host-")); });
afterEach(async () => { await daemon?.stop().catch(() => {}); daemon = undefined; await rm(dir, { recursive: true, force: true }); });
const socket = (name: string) => meshSocketPath(dir, name);

function fakeCp() {
  let listener: ((e: MeshEvent) => void) | undefined;
  const calls: string[] = [];
  const cp: BridgeControlPlane = {
    on(l) { listener = l; return () => { listener = undefined; }; },
    snapshotEvents() { return []; },
    async prompt(target, text) { calls.push(`prompt:${target}:${text}`); listener?.({ kind: "log", text: "got prompt", ts: "t" }); return {}; },
    removeQueuedTurn(target, turnId) { calls.push(`removeQueuedTurn:${target}:${turnId}`); return true; },
    async steer(target, text) { calls.push(`steer:${target}:${text}`); listener?.({ kind: "steer", from: "operator", to: target, body: text, ts: "t" }); },
    resolveDecision(requestId, optionId) { calls.push(`resolve:${requestId}:${optionId}`); return true; },
    async setMode(target, modeId) { calls.push(`setMode:${target}:${modeId}`); },
    async setModel(target, modelId) { calls.push(`setModel:${target}:${modelId}`); },
    async setEffort(target, effort) { calls.push(`setEffort:${target}:${effort ?? "default"}`); },
    async interrupt(target) { calls.push(`interrupt:${target}`); },
    async newSession(target) { calls.push(`newSession:${target}`); },
    async applyBoard(actor, command, ebr) {
      calls.push(`board:${command.type}:${actor.kind}:${ebr}`);
      if ((command as any).title === "boom") throw new Error("kaboom");
      if ((command as any).title === "stale") return { ok: false, code: "conflict", error: "revision conflict" };
      if ((command as any).type === "frobnicate") return { ok: false, code: "invalid", error: "unknown board command" };
      return { ok: true, state: { mesh: "x", revision: ebr + 1, epicSeq: 0, taskSeq: 1, epics: [], tasks: [] }, change: { entity: "task", taskId: 1 } };
    },
    async newAllSessions() { calls.push("newAllSessions"); },
    async wakeAgent(target) { calls.push(`wake:${target}`); },
    async stopAgent(target) { calls.push(`stopAgent:${target}`); },
    addEdge(edge) { calls.push(`addEdge:${edge.from}:${edge.to}:${edge.steer === true}`); },
    addAgent(agent, edges = []) { calls.push(`addAgent:${agent.id}:${edges.map((e) => `${e.from}->${e.to}`).join(",")}`); },
    async stop() { calls.push("stop"); },
  };
  return { cp, calls, emit: (e: MeshEvent) => listener?.(e) };
}

/** Connect a raw client to the daemon socket, collecting parsed frames. */
async function connect(sock: string) {
  const got: any[] = [];
  const lb = new LineBuffer();
  const c = net.connect(sock);
  c.setEncoding("utf8");
  c.on("data", (d: string) => { for (const line of lb.push(d)) got.push(JSON.parse(line)); });
  await new Promise<void>((res) => c.once("connect", () => res()));
  return { c, got, send: (m: any) => c.write(encodeFrame(m)) };
}

test("hello → ack(running, proto, seq); prompt relays a seq'd event; commands apply; stop", async () => {
  const sock = socket("t");
  const { cp, calls } = fakeCp();
  daemon = new MeshHostDaemon(cp, { socketPath: sock });
  await daemon.listen();
  daemon.markReady();

  const { got, send } = await connect(sock);
  send({ t: "hello", proto: PROTO_VERSION, resumeFrom: 0 });
  await Bun.sleep(50);
  const ack = got.find((m) => m.t === "ack");
  expect(ack).toMatchObject({ t: "ack", proto: PROTO_VERSION, running: true });

  send({ t: "prompt", target: "router", text: "hi" });
  send({ t: "steer", target: "codex-1", text: "urgent" });
  await Bun.sleep(50);
  expect(calls).toContain("prompt:router:hi");
  expect(calls).toContain("steer:codex-1:urgent");
  const ev = got.find((m) => m.t === "event" && m.event.kind === "log");
  expect(ev).toBeTruthy();
  expect(typeof ev.seq).toBe("number");

  send({ t: "setMode", target: "codex-1", modeId: "read-only", reqId: "m1" });
  send({ t: "setModel", target: "codex-1", modelId: "kimi-k2", reqId: "m2" });
  send({ t: "setEffort", target: "codex-1", effort: "high", reqId: "m3" });
  send({ t: "removeQueuedTurn", target: "codex-1", turnId: "turn-1" });
  send({ t: "interrupt", target: "codex-1" });
  send({ t: "newSession", target: "codex-1" });
  send({ t: "newAllSessions" });
  send({ t: "wake", target: "codex-1" });
  send({ t: "addEdge", edge: { from: "router", to: "codex-1", steer: true } });
  send({ t: "addAgent", agent: { id: "newbie", harness: "codex", project: ".", role: "member", lazy: true }, edges: [{ from: "router", to: "newbie" }] });
  await Bun.sleep(50);
  expect(calls).toContain("setMode:codex-1:read-only");
  expect(calls).toContain("setModel:codex-1:kimi-k2");
  expect(calls).toContain("setEffort:codex-1:high");
  // config mutations are acked with a cmdResult carrying the honest apply status
  expect(got).toContainEqual({ t: "cmdResult", reqId: "m1", status: "applied_by_acp" });
  expect(got).toContainEqual({ t: "cmdResult", reqId: "m2", status: "accepted_by_host" });
  expect(got).toContainEqual({ t: "cmdResult", reqId: "m3", status: "accepted_by_host" });
  expect(calls).toContain("removeQueuedTurn:codex-1:turn-1");
  expect(calls).toContain("interrupt:codex-1");
  expect(calls).toContain("newSession:codex-1");
  expect(calls).toContain("newAllSessions");
  expect(calls).toContain("wake:codex-1");
  expect(calls).toContain("addEdge:router:codex-1:true");
  expect(calls).toContain("addAgent:newbie:router->newbie");

  send({ t: "stop" });
  await Bun.sleep(50);
  expect(calls).toContain("stop");
  expect(got.some((m) => m.t === "stopped")).toBe(true);
});

test("state-changing commands are applied in socket order", async () => {
  const sock = socket("ordered");
  const { cp, calls } = fakeCp();
  let releaseMode!: () => void;
  (cp as any).setMode = async (target: string, modeId: string) => {
    calls.push(`setMode:start:${target}:${modeId}`);
    await new Promise<void>((resolve) => {
      releaseMode = resolve;
    });
    calls.push(`setMode:done:${target}:${modeId}`);
  };
  (cp as any).newSession = async (target: string) => {
    calls.push(`newSession:${target}`);
  };
  daemon = new MeshHostDaemon(cp, { socketPath: sock });
  await daemon.listen();
  daemon.markReady();

  const { send } = await connect(sock);
  send({ t: "hello", proto: PROTO_VERSION, resumeFrom: 0 });
  send({ t: "setMode", target: "codex-1", modeId: "plan" });
  send({ t: "newSession", target: "codex-1" });
  await Bun.sleep(50);
  expect(calls).toEqual(["setMode:start:codex-1:plan"]);

  releaseMode();
  await Bun.sleep(50);
  expect(calls).toEqual(["setMode:start:codex-1:plan", "setMode:done:codex-1:plan", "newSession:codex-1"]);
});

test("a config mutation acks only AFTER the control-plane call settles", async () => {
  const sock = socket("ack-after");
  const { cp, calls } = fakeCp();
  let releaseMode!: () => void;
  (cp as any).setMode = async (target: string, modeId: string) => {
    calls.push(`setMode:start:${target}:${modeId}`);
    await new Promise<void>((resolve) => { releaseMode = resolve; });
    calls.push(`setMode:done:${target}:${modeId}`);
  };
  daemon = new MeshHostDaemon(cp, { socketPath: sock });
  await daemon.listen();
  daemon.markReady();

  const { got, send } = await connect(sock);
  send({ t: "hello", proto: PROTO_VERSION, resumeFrom: 0 });
  send({ t: "setMode", target: "codex-1", modeId: "plan", reqId: "r1" });
  await Bun.sleep(50);
  // The cp call is still in flight: no cmdResult yet.
  expect(calls).toEqual(["setMode:start:codex-1:plan"]);
  expect(got.some((m) => m.t === "cmdResult")).toBe(false);

  releaseMode();
  await Bun.sleep(50);
  expect(got).toContainEqual({ t: "cmdResult", reqId: "r1", status: "applied_by_acp" });
});

test("a board command returns a boardResult: ok, board-error-as-result, and throw-as-error", async () => {
  const sock = socket("board-rpc");
  const { cp } = fakeCp();
  daemon = new MeshHostDaemon(cp, { socketPath: sock });
  await daemon.listen();
  daemon.markReady();

  const { got, send } = await connect(sock);
  send({ t: "hello", proto: PROTO_VERSION, resumeFrom: 0 });
  send({ t: "board", reqId: "b1", actor: { kind: "human" }, command: { type: "create_task", title: "ok" }, expectedBoardRevision: 0 });
  send({ t: "board", reqId: "b2", actor: { kind: "human" }, command: { type: "create_task", title: "stale" }, expectedBoardRevision: 0 });
  send({ t: "board", reqId: "b3", actor: { kind: "human" }, command: { type: "create_task", title: "boom" }, expectedBoardRevision: 0 });
  send({ t: "board", reqId: "b4", actor: { kind: "human" }, command: { type: "frobnicate" } as any, expectedBoardRevision: 0 });
  await Bun.sleep(50);

  const r1 = got.find((m) => m.t === "boardResult" && m.reqId === "b1");
  expect(r1.result).toMatchObject({ ok: true, change: { entity: "task", taskId: 1 } });
  expect(r1.error).toBeUndefined();

  const r2 = got.find((m) => m.t === "boardResult" && m.reqId === "b2");
  expect(r2.result).toMatchObject({ ok: false, code: "conflict" }); // board error rides in result
  expect(r2.error).toBeUndefined();

  const r3 = got.find((m) => m.t === "boardResult" && m.reqId === "b3");
  expect(r3.error).toBe("kaboom"); // a thrown handler is a transport error

  const r4 = got.find((m) => m.t === "boardResult" && m.reqId === "b4");
  expect(r4.result).toMatchObject({ ok: false, code: "invalid" }); // unknown type resolves as a result
  expect(r4.error).toBeUndefined();
});

test("MeshHostClient.boardCommand resolves with the structured result over the socket", async () => {
  const sock = socket("board-client");
  const { cp } = fakeCp();
  daemon = new MeshHostDaemon(cp, { socketPath: sock });
  await daemon.listen();
  daemon.markReady();

  const config: MeshConfig = { name: "board-client", agents: [{ id: "router", harness: "claude", project: ".", role: "router" }], edges: [] };
  const client = new MeshHostClient({ name: config.name, config, socketPath: sock, onEvent: () => {} });
  await client.attach({ pid: process.pid }, 0);
  try {
    const ok = await client.boardCommand({ kind: "human" }, { type: "create_task", title: "x" }, 0);
    expect(ok).toMatchObject({ ok: true, change: { entity: "task", taskId: 1 } });
    const conflict = await client.boardCommand({ kind: "human" }, { type: "create_task", title: "stale" }, 0);
    expect(conflict).toMatchObject({ ok: false, code: "conflict" });
  } finally {
    client.disconnect();
  }
});

test("a throwing config mutation returns an error result and the queue stays alive", async () => {
  const sock = socket("ack-error");
  const { cp, calls } = fakeCp();
  (cp as any).setModel = async () => { throw new Error("no such model"); };
  daemon = new MeshHostDaemon(cp, { socketPath: sock });
  await daemon.listen();
  daemon.markReady();

  const { got, send } = await connect(sock);
  send({ t: "hello", proto: PROTO_VERSION, resumeFrom: 0 });
  send({ t: "setModel", target: "codex-1", modelId: "bad", reqId: "e1" });
  // A later command on the same queue must still run despite the failure above.
  send({ t: "setEffort", target: "codex-1", effort: "high", reqId: "e2" });
  await Bun.sleep(50);

  expect(got).toContainEqual({ t: "cmdResult", reqId: "e1", error: "no such model" });
  expect(got).toContainEqual({ t: "cmdResult", reqId: "e2", status: "accepted_by_host" });
  expect(calls).toContain("setEffort:codex-1:high");
});

test("events emitted before connect are replayed on hello(resumeFrom)", async () => {
  const sock = socket("replay");
  const { cp, emit } = fakeCp();
  daemon = new MeshHostDaemon(cp, { socketPath: sock });
  await daemon.listen();
  daemon.markReady();

  // three events buffer into the ring before any client connects
  emit({ kind: "log", text: "one", ts: "t" });
  emit({ kind: "log", text: "two", ts: "t" });
  emit({ kind: "log", text: "three", ts: "t" });

  const { got, send } = await connect(sock);
  send({ t: "hello", proto: PROTO_VERSION, resumeFrom: 0 });
  await Bun.sleep(50);
  const replay = got.find((m) => m.t === "replay");
  expect(replay).toBeTruthy();
  expect(replay.events.map((e: any) => e.event.text)).toEqual(["one", "two", "three"]);

  // a resume from seq 2 only replays what's newer
  const { got: got2, send: send2 } = await connect(sock);
  send2({ t: "hello", proto: PROTO_VERSION, resumeFrom: 2 });
  await Bun.sleep(50);
  const replay2 = got2.find((m) => m.t === "replay");
  expect(replay2.events.map((e: any) => e.event.text)).toEqual(["three"]);
});

test("hello backfills current agent state after ring replay", async () => {
  const sock = socket("snapshot");
  const { cp, emit } = fakeCp();
  (cp as any).snapshotEvents = () => [
    { kind: "agent_status", agent: "router", status: "ready", ts: "snap" },
    { kind: "agent_activity", agent: "router", activity: "idle", ts: "snap" },
    { kind: "agent_capabilities", agent: "router", image: true, ts: "snap" },
    { kind: "agent_modes", agent: "router", current: "default", available: [{ id: "default", name: "Default" }], ts: "snap" },
    { kind: "agent_models", agent: "router", current: "test-model", available: [{ id: "test-model", name: "Test Model" }], ts: "snap" },
  ];
  daemon = new MeshHostDaemon(cp, { socketPath: sock, ringCap: 1 });
  await daemon.listen();
  daemon.markReady();

  // Simulate a long-running daemon whose original startup events have rolled out of the ring.
  emit({ kind: "agent_status", agent: "router", status: "spawning", ts: "old" });
  emit({ kind: "log", text: "later event", ts: "newer" });

  const { got, send } = await connect(sock);
  send({ t: "hello", proto: PROTO_VERSION, resumeFrom: 0 });
  await Bun.sleep(50);

  const replay = got.find((m) => m.t === "replay");
  expect(replay.events.map((e: any) => e.event.kind)).toEqual(["log"]);
  expect(replay.events.map((e: any) => e.seq)).toEqual([2]);
  const snapshot = got.find((m) => m.t === "snapshot");
  expect(snapshot).toBeTruthy();
  const events = snapshot.events;
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "router", status: "ready" }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "router", activity: "idle" }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_capabilities", agent: "router", image: true }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_modes", agent: "router", current: "default" }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_models", agent: "router", current: "test-model" }));
  expect(got.filter((m) => m.t === "event")).toHaveLength(0);
  expect(got.find((m) => m.t === "ack")?.seq).toBe(2);
});

test("mesh host client applies snapshot without advancing last seq", async () => {
  const sock = socket("client-snapshot");
  const { cp, emit } = fakeCp();
  (cp as any).snapshotEvents = () => [
    { kind: "agent_status", agent: "router", status: "ready", ts: "snap" },
    { kind: "agent_capabilities", agent: "router", image: true, ts: "snap" },
  ];
  daemon = new MeshHostDaemon(cp, { socketPath: sock, ringCap: 1 });
  await daemon.listen();
  daemon.markReady();
  emit({ kind: "agent_status", agent: "router", status: "spawning", ts: "old" });
  emit({ kind: "log", text: "later event", ts: "newer" });

  const config: MeshConfig = {
    name: "snapshot-client",
    agents: [{ id: "router", harness: "claude", project: ".", role: "router" }],
    edges: [],
  };
  const events: MeshEvent[] = [];
  const client = new MeshHostClient({ name: config.name, config, socketPath: sock, onEvent: (e) => events.push(e) });
  await client.attach({ pid: process.pid }, 0);

  expect(events).toContainEqual(expect.objectContaining({ kind: "log", text: "later event" }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "router", status: "ready" }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_capabilities", agent: "router", image: true }));
  expect(client.seq).toBe(2);
  client.disconnect();
});

test("a second client takes over; the first is dropped", async () => {
  const sock = socket("takeover");
  const { cp, emit } = fakeCp();
  daemon = new MeshHostDaemon(cp, { socketPath: sock });
  await daemon.listen();
  daemon.markReady();

  const a = await connect(sock);
  a.send({ t: "hello", proto: PROTO_VERSION, resumeFrom: 0 });
  await Bun.sleep(30);
  const b = await connect(sock); // latest wins
  b.send({ t: "hello", proto: PROTO_VERSION, resumeFrom: 0 });
  await Bun.sleep(30);

  emit({ kind: "log", text: "after-takeover", ts: "t" });
  await Bun.sleep(50);
  expect(b.got.some((m) => m.t === "event" && m.event.text === "after-takeover")).toBe(true);
  expect(a.got.some((m) => m.t === "event" && m.event.text === "after-takeover")).toBe(false);
});
