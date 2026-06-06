// src/mesh-host.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeControlPlaneToSocket, type BridgeControlPlane } from "./mesh-host";
import { LineBuffer, encodeFrame } from "./protocol";
import type { MeshEvent } from "./acp/types";

let dir: string;
let server: net.Server;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "host-")); });
afterEach(async () => { server?.close(); await rm(dir, { recursive: true, force: true }); });

function fakeCp() {
  let listener: ((e: MeshEvent) => void) | undefined;
  const calls: string[] = [];
  const cp: BridgeControlPlane = {
    on(l) { listener = l; return () => { listener = undefined; }; },
    async prompt(target, text) { calls.push(`prompt:${target}:${text}`); listener?.({ kind: "log", text: "got prompt", ts: "t" }); return {}; },
    resolveDecision(requestId, optionId) { calls.push(`resolve:${requestId}:${optionId}`); return true; },
    async setMode(target, modeId) { calls.push(`setMode:${target}:${modeId}`); },
    async interrupt(target) { calls.push(`interrupt:${target}`); },
    async stop() { calls.push("stop"); },
  };
  return { cp, calls };
}

test("bridge sends ready, relays events, applies commands, and stops", async () => {
  const sock = join(dir, "t.sock");
  const { cp, calls } = fakeCp();

  const got: any[] = [];
  const lb = new LineBuffer();
  const connected = new Promise<net.Socket>((res) => {
    server = net.createServer((s) => { bridgeControlPlaneToSocket(cp, s); res(s); });
  });
  await new Promise<void>((r) => server.listen(sock, r));

  const client = net.connect(sock);
  client.setEncoding("utf8");
  client.on("data", (d: string) => { for (const line of lb.push(d)) got.push(JSON.parse(line)); });
  await connected;

  // ready arrives first
  await Bun.sleep(50);
  expect(got[0]).toEqual({ t: "ready" });

  // a prompt command is applied and its emitted event relayed back
  client.write(encodeFrame({ t: "prompt", target: "router", text: "hi" }));
  await Bun.sleep(50);
  expect(calls).toContain("prompt:router:hi");
  expect(got.some((m) => m.t === "event" && m.event.kind === "log")).toBe(true);

  // setMode command is relayed to the cp
  client.write(encodeFrame({ t: "setMode", target: "codex-1", modeId: "read-only" }));
  await Bun.sleep(50);
  expect(calls).toContain("setMode:codex-1:read-only");

  // interrupt command is relayed to the cp
  client.write(encodeFrame({ t: "interrupt", target: "codex-1" }));
  await Bun.sleep(50);
  expect(calls).toContain("interrupt:codex-1");

  // stop -> cp.stop() called, {t:"stopped"} sent
  client.write(encodeFrame({ t: "stop" }));
  await Bun.sleep(50);
  expect(calls).toContain("stop");
  expect(got.some((m) => m.t === "stopped")).toBe(true);

  client.destroy();
});

test("signalReady:false defers ready frame but still forwards events", async () => {
  const sock = join(dir, "t2.sock");
  const { cp } = fakeCp();
  let cpListener: ((e: MeshEvent) => void) | undefined;
  // wrap cp.on so the test can drive event emission directly
  const wrapped: BridgeControlPlane = {
    ...cp,
    on(l) { cpListener = l; return () => { cpListener = undefined; }; },
  };

  const got: any[] = [];
  const lb = new LineBuffer();
  const connected = new Promise<net.Socket>((res) => {
    server = net.createServer((s) => { bridgeControlPlaneToSocket(wrapped, s, { signalReady: false }); res(s); });
  });
  await new Promise<void>((r) => server.listen(sock, r));

  const client = net.connect(sock);
  client.setEncoding("utf8");
  client.on("data", (d: string) => { for (const line of lb.push(d)) got.push(JSON.parse(line)); });
  await connected;

  // no ready frame on attach
  await Bun.sleep(50);
  expect(got.some((m) => m.t === "ready")).toBe(false);

  // events are still forwarded over the socket
  cpListener?.({ kind: "log", text: "startup event", ts: "t" });
  await Bun.sleep(50);
  expect(got.some((m) => m.t === "event" && m.event.kind === "log")).toBe(true);
  // still no ready frame after forwarding an event
  expect(got.some((m) => m.t === "ready")).toBe(false);

  client.destroy();
});
