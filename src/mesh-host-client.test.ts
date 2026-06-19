// src/mesh-host-client.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { MeshHostClient } from "./mesh-host-client";
import { meshSocketPath } from "./mesh-socket";
import { LineBuffer, encodeFrame, PROTO_VERSION, type ParentMsg, type ChildMsg } from "./protocol";
import type { MeshConfig, MeshEvent } from "./acp/types";

const cfg: MeshConfig = {
  name: "echo",
  agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }],
  edges: [],
};
const FIXTURE = join(import.meta.dir, "fixtures", "echo-host.ts");

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "client-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const socket = (name: string) => meshSocketPath(dir, name);

test("start resolves on ready; prompt relays an event; stop reaps the process", async () => {
  const events: MeshEvent[] = [];
  const client = new MeshHostClient({
    name: cfg.name,
    config: cfg,
    socketPath: socket("echo"),
    hostScript: FIXTURE,
    runDir: dir,
    onEvent: (e) => events.push(e),
  });

  await client.start(); // resolves only after {t:"ready"}
  const pid = client.pid!;
  expect(pid).toBeGreaterThan(0);

  client.prompt("r", "hello");
  client.removeQueuedTurn("r", "turn-1");
  await Bun.sleep(100);
  expect(events.some((e) => e.kind === "log" && e.text === "echo:hello")).toBe(true);
  expect(events.some((e) => e.kind === "log" && e.text === "removeQueuedTurn:r:turn-1")).toBe(true);

  await client.stop();
  // process is gone -> signalling it throws ESRCH
  expect(() => process.kill(pid, 0)).toThrow();
});

test(
  "start() rejects if the host process exits before ready",
  async () => {
    const client = new MeshHostClient({
      name: "bad",
      config: cfg,
      socketPath: socket("bad"),
      hostScript: join(dir, "does-not-exist.ts"),
      runDir: dir,
    });
    await expect(client.start()).rejects.toThrow(/before ready|exited/i);
  },
  5000, // timeout: fail fast, not hang
);

/** A minimal in-process daemon: acks `hello` so the client handshake completes, records every
 *  parent frame, and lets the test drive result frames / connection lifecycle by hand. */
function fakeDaemon(socketPath: string, onFrame: (frame: ParentMsg, sock: net.Socket) => void) {
  const sockets: net.Socket[] = [];
  const frames: ParentMsg[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.setEncoding("utf8");
    const lb = new LineBuffer();
    sock.on("data", (chunk: string) => {
      for (const line of lb.push(chunk)) {
        const frame = JSON.parse(line) as ParentMsg;
        if (frame.t === "hello") {
          sock.write(encodeFrame({ t: "ack", proto: PROTO_VERSION, running: true, seq: 0 } as ChildMsg));
          continue;
        }
        frames.push(frame);
        onFrame(frame, sock);
      }
    });
    sock.on("error", () => {});
  });
  return {
    frames,
    sockets,
    listen: () => new Promise<void>((res) => server.listen(socketPath, res)),
    // Destroy any still-open connections first; otherwise server.close() waits on the
    // orphaned socket left behind by a takeover and never returns.
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((res) => server.close(() => res()));
    },
  };
}

async function attachToFake(
  socketPath: string,
  onFrame: (frame: ParentMsg, sock: net.Socket) => void,
  rpcTimeoutMs?: number,
): Promise<{ client: MeshHostClient; daemon: ReturnType<typeof fakeDaemon> }> {
  const daemon = fakeDaemon(socketPath, onFrame);
  await daemon.listen();
  const client = new MeshHostClient({ name: cfg.name, config: cfg, socketPath, rpcTimeoutMs });
  await client.attach({ pid: process.pid });
  return { client, daemon };
}

test("setMode resolves with the host ack status", async () => {
  const sock = socket("ack");
  const { client, daemon } = await attachToFake(sock, (frame, s) => {
    if (frame.t === "setMode") s.write(encodeFrame({ t: "cmdResult", reqId: frame.reqId, status: "applied_by_acp" } as ChildMsg));
  });
  try {
    await expect(client.setMode("r", "read-only")).resolves.toEqual({ status: "applied_by_acp" });
  } finally {
    client.disconnect();
    await daemon.close();
  }
});

test("a host error result rejects the mutation waiter", async () => {
  const sock = socket("err");
  const { client, daemon } = await attachToFake(sock, (frame, s) => {
    if (frame.t === "setModel") s.write(encodeFrame({ t: "cmdResult", reqId: frame.reqId, error: "no such agent" } as ChildMsg));
  });
  try {
    await expect(client.setModel("r", "kimi-k2")).rejects.toThrow(/no such agent/);
  } finally {
    client.disconnect();
    await daemon.close();
  }
});

test("a mutation with no answer rejects on timeout (no waiter leak)", async () => {
  const sock = socket("timeout");
  // Daemon intentionally never answers the setEffort frame.
  const { client, daemon } = await attachToFake(sock, () => {}, 80);
  try {
    await expect(client.setEffort("r", "high")).rejects.toThrow(/timed out/);
  } finally {
    client.disconnect();
    await daemon.close();
  }
});

test("an in-flight mutation rejects when the socket closes", async () => {
  const sock = socket("close");
  const { client, daemon } = await attachToFake(sock, (frame, s) => {
    if (frame.t === "setMode") s.destroy(); // drop the connection before answering
  });
  try {
    await expect(client.setMode("r", "plan")).rejects.toThrow(/connection closed/);
  } finally {
    client.disconnect();
    await daemon.close();
  }
});

test("an in-flight mutation rejects when a new connection takes over", async () => {
  const sock = socket("takeover");
  // Never answer, so the waiter is still pending when we reattach.
  const { client, daemon } = await attachToFake(sock, () => {});
  try {
    const outcome = client.setMode("r", "read-only").then(() => "resolved", (e: Error) => e.message);
    await client.attach({ pid: process.pid }); // second connection supersedes the first
    expect(await outcome).toMatch(/connection replaced/);
  } finally {
    client.disconnect();
    await daemon.close();
  }
});
