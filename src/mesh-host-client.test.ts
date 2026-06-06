// src/mesh-host-client.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshHostClient } from "./mesh-host-client";
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

test("start resolves on ready; prompt relays an event; stop reaps the process", async () => {
  const events: MeshEvent[] = [];
  const client = new MeshHostClient({
    name: cfg.name,
    config: cfg,
    socketPath: join(dir, "echo.sock"),
    hostScript: FIXTURE,
    onEvent: (e) => events.push(e),
  });

  await client.start(); // resolves only after {t:"ready"}
  const pid = client.pid!;
  expect(pid).toBeGreaterThan(0);

  client.prompt("r", "hello");
  await Bun.sleep(100);
  expect(events.some((e) => e.kind === "log" && e.text === "echo:hello")).toBe(true);

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
      socketPath: join(dir, "bad.sock"),
      hostScript: join(dir, "does-not-exist.ts"),
    });
    await expect(client.start()).rejects.toThrow(/before ready|exited/i);
  },
  5000, // timeout: fail fast, not hang
);
