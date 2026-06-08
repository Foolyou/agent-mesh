// src/mesh-host.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshHostDaemon, type BridgeControlPlane } from "./mesh-host";
import { LineBuffer, encodeFrame, PROTO_VERSION } from "./protocol";
import type { MeshEvent } from "./acp/types";

let dir: string;
let daemon: MeshHostDaemon | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "host-")); });
afterEach(async () => { await daemon?.stop().catch(() => {}); daemon = undefined; await rm(dir, { recursive: true, force: true }); });

function fakeCp() {
  let listener: ((e: MeshEvent) => void) | undefined;
  const calls: string[] = [];
  const cp: BridgeControlPlane = {
    on(l) { listener = l; return () => { listener = undefined; }; },
    snapshotEvents() { return []; },
    async prompt(target, text) { calls.push(`prompt:${target}:${text}`); listener?.({ kind: "log", text: "got prompt", ts: "t" }); return {}; },
    resolveDecision(requestId, optionId) { calls.push(`resolve:${requestId}:${optionId}`); return true; },
    async setMode(target, modeId) { calls.push(`setMode:${target}:${modeId}`); },
    async interrupt(target) { calls.push(`interrupt:${target}`); },
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
  const sock = join(dir, "t.sock");
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
  await Bun.sleep(50);
  expect(calls).toContain("prompt:router:hi");
  const ev = got.find((m) => m.t === "event" && m.event.kind === "log");
  expect(ev).toBeTruthy();
  expect(typeof ev.seq).toBe("number");

  send({ t: "setMode", target: "codex-1", modeId: "read-only" });
  send({ t: "interrupt", target: "codex-1" });
  await Bun.sleep(50);
  expect(calls).toContain("setMode:codex-1:read-only");
  expect(calls).toContain("interrupt:codex-1");

  send({ t: "stop" });
  await Bun.sleep(50);
  expect(calls).toContain("stop");
  expect(got.some((m) => m.t === "stopped")).toBe(true);
});

test("events emitted before connect are replayed on hello(resumeFrom)", async () => {
  const sock = join(dir, "replay.sock");
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
  const sock = join(dir, "snapshot.sock");
  const { cp, emit } = fakeCp();
  (cp as any).snapshotEvents = () => [
    { kind: "agent_status", agent: "router", status: "ready", ts: "snap" },
    { kind: "agent_activity", agent: "router", activity: "idle", ts: "snap" },
    { kind: "agent_capabilities", agent: "router", image: true, ts: "snap" },
    { kind: "agent_modes", agent: "router", current: "default", available: [{ id: "default", name: "Default" }], ts: "snap" },
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
  const events = got.filter((m) => m.t === "event").map((m) => m.event);
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_status", agent: "router", status: "ready" }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_activity", agent: "router", activity: "idle" }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_capabilities", agent: "router", image: true }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "agent_modes", agent: "router", current: "default" }));
});

test("a second client takes over; the first is dropped", async () => {
  const sock = join(dir, "takeover.sock");
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
