# Control Agent + Multi-Mesh Lifecycle + Router Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human, from one process, instruct an optional LLM master agent to create/start/stop multiple meshes (each running in its own subprocess), and enter a running mesh to chat with its Router.

**Architecture:** Process-per-mesh (Approach C). A parent `MeshManager` owns the deterministic lifecycle (validate, persist, spawn, stop, aggregate events) and supervises one `mesh-host` subprocess per running mesh over a per-mesh Unix domain socket speaking NDJSON. Today's `ControlPlane` becomes the subprocess body, ~unchanged. An optional `MasterAgent` (claude ACP) exposes `create/start/stop/list_mesh` MCP tools that call `MeshManager`. The TUI gains a text-input line, a mesh list, and a Router chat pane.

**Tech Stack:** Bun + TypeScript, `bun test`, `node:net` (Unix sockets), `@zed-industries/agent-client-protocol` (ACP), `@modelcontextprotocol/sdk` (MCP over HTTP).

**Spec:** `docs/superpowers/specs/2026-06-06-control-agent-multi-mesh-design.md`

---

## File structure

New files:
- `src/protocol.ts` — parent⇄child message types + NDJSON `LineBuffer` + `encodeFrame`.
- `src/mesh-validate.ts` — pure `validateMeshConfig(config)`.
- `src/mesh-store.ts` — persist/load mesh definitions under `.mesh/meshes/`.
- `src/mesh-host.ts` — subprocess entrypoint + reusable `bridgeControlPlaneToSocket`.
- `src/mesh-host-client.ts` — parent-side wrapper around one subprocess + socket.
- `src/mesh-manager.ts` — deterministic lifecycle core + aggregated event bus.
- `src/mcp/mesh-control.ts` — MCP server (`create/start/stop/list_mesh`) + handler wrappers.
- `src/master-agent.ts` — claude ACP connection wired to the mesh-control MCP.
- `src/tui/line-editor.ts` — pure single-line input editor.
- `src/fixtures/echo-host.ts` — test fixture: a fake mesh-host speaking the protocol.

Modified files:
- `src/acp/client.ts` — export `killTree`.
- `src/control-plane.ts` — add `setMode(id, modeId)` convenience method.
- `src/tui/app.ts` — input line, mesh list, Router chat pane, fullscreen toggle.
- `src/main.ts` — boot `MeshManager` + `MasterAgent` + new TUI.
- `src/e2e.ts` — drive the demo mesh through `MeshManager`.
- `README.md` — document the new model and commands.

Reused as-is: `src/acp/types.ts`, `src/mcp/mesh-services.ts`, `src/mailbox.ts`, `src/mesh.ts`, `src/harness.ts`, `src/config.ts`.

---

## Task 1: Protocol module (types + line framing)

**Files:**
- Create: `src/protocol.ts`
- Test: `src/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/protocol.test.ts
import { test, expect } from "bun:test";
import { LineBuffer, encodeFrame } from "./protocol";

test("encodeFrame appends exactly one newline", () => {
  expect(encodeFrame({ t: "ready" })).toBe('{"t":"ready"}\n');
});

test("LineBuffer splits complete lines and holds the partial remainder", () => {
  const lb = new LineBuffer();
  expect(lb.push('{"a":1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
  expect(lb.push(':3}\n')).toEqual(['{"c":3}']);
});

test("LineBuffer drops blank lines", () => {
  const lb = new LineBuffer();
  expect(lb.push("\n\n")).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/protocol.test.ts`
Expected: FAIL — `Cannot find module './protocol'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/protocol.ts
// NDJSON control protocol between the parent MeshManager and each mesh-host
// subprocess, carried over a per-mesh Unix domain socket.
import type { MeshEvent } from "./acp/types";

/** child (mesh-host) -> parent (MeshManager) */
export type ChildMsg =
  | { t: "ready" }
  | { t: "event"; event: MeshEvent }
  | { t: "stopped" };

/** parent (MeshManager) -> child (mesh-host) */
export type ParentMsg =
  | { t: "prompt"; target: string; text: string }
  | { t: "resolve"; requestId: string; optionId: string }
  | { t: "setMode"; target: string; modeId: string }
  | { t: "stop" };

export function encodeFrame(msg: ChildMsg | ParentMsg): string {
  return JSON.stringify(msg) + "\n";
}

/** Accumulates socket chunks and yields complete, non-blank lines. */
export class LineBuffer {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts.filter((l) => l.trim().length > 0);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/protocol.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts src/protocol.test.ts
git commit -m "feat: NDJSON control protocol types + line framing"
```

---

## Task 2: Mesh config validation

**Files:**
- Create: `src/mesh-validate.ts`
- Test: `src/mesh-validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/mesh-validate.test.ts
import { test, expect } from "bun:test";
import { validateMeshConfig } from "./mesh-validate";
import type { MeshConfig } from "./acp/types";

const ok: MeshConfig = {
  name: "good",
  agents: [
    { id: "r", harness: "claude", project: "test_mesh_0", role: "router" },
    { id: "m", harness: "codex", project: "test_mesh_0", role: "member" },
  ],
  edges: [["r", "m"]],
};

test("accepts a valid mesh", () => {
  expect(() => validateMeshConfig(ok)).not.toThrow();
});

test("rejects unsafe names", () => {
  expect(() => validateMeshConfig({ ...ok, name: "../escape" })).toThrow(/name/i);
});

test("rejects empty agents", () => {
  expect(() => validateMeshConfig({ ...ok, agents: [] })).toThrow(/at least one/i);
});

test("requires exactly one router", () => {
  const two = { ...ok, agents: ok.agents.map((a) => ({ ...a, role: "router" as const })) };
  expect(() => validateMeshConfig(two)).toThrow(/exactly one router/i);
});

test("rejects unknown harness", () => {
  const bad = { ...ok, agents: [{ ...ok.agents[0]!, harness: "gpt" as any }, ok.agents[1]!] };
  expect(() => validateMeshConfig(bad)).toThrow(/harness/i);
});

test("rejects duplicate agent ids", () => {
  const dup = { ...ok, agents: [ok.agents[0]!, { ...ok.agents[1]!, id: "r" }] };
  expect(() => validateMeshConfig(dup)).toThrow(/duplicate/i);
});

test("rejects edges referencing unknown agents", () => {
  expect(() => validateMeshConfig({ ...ok, edges: [["r", "ghost"]] })).toThrow(/edge/i);
});

test("rejects absolute project paths", () => {
  const abs = { ...ok, agents: [{ ...ok.agents[0]!, project: "/etc" }, ok.agents[1]!] };
  expect(() => validateMeshConfig(abs)).toThrow(/relative/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/mesh-validate.test.ts`
Expected: FAIL — `Cannot find module './mesh-validate'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mesh-validate.ts
// Deterministic validation of a mesh topology. The control plane runs this over
// every (possibly LLM-generated) MeshConfig before defining/persisting it.
import { isAbsolute } from "node:path";
import { HARNESSES } from "./harness";
import type { MeshConfig } from "./acp/types";

export function validateMeshConfig(config: MeshConfig): void {
  const { name, agents, edges } = config;

  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`invalid mesh name "${name}": use only letters, digits, '.', '_', '-'`);
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error("mesh must have at least one agent");
  }

  const routers = agents.filter((a) => a.role === "router");
  if (routers.length !== 1) {
    throw new Error(`mesh must have exactly one router (found ${routers.length})`);
  }

  const ids = new Set<string>();
  for (const a of agents) {
    if (!(a.harness in HARNESSES)) {
      throw new Error(`agent "${a.id}" has unknown harness "${a.harness}"`);
    }
    if (ids.has(a.id)) throw new Error(`duplicate agent id "${a.id}"`);
    ids.add(a.id);
    if (!a.project || isAbsolute(a.project)) {
      throw new Error(`agent "${a.id}" project must be a relative path (got "${a.project}")`);
    }
  }

  for (const [from, to] of edges ?? []) {
    if (!ids.has(from) || !ids.has(to)) {
      throw new Error(`edge [${from}, ${to}] references an unknown agent`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/mesh-validate.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-validate.ts src/mesh-validate.test.ts
git commit -m "feat: deterministic mesh topology validation"
```

---

## Task 3: Mesh definition store (persistence)

**Files:**
- Create: `src/mesh-store.ts`
- Test: `src/mesh-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/mesh-store.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshStore } from "./mesh-store";
import type { MeshConfig } from "./acp/types";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "meshstore-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const cfg: MeshConfig = {
  name: "alpha",
  agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }],
  edges: [],
};

test("define then load round-trips the config", async () => {
  const store = new MeshStore(dir);
  await store.define(cfg);
  const loaded = await store.load();
  expect(loaded).toEqual([cfg]);
});

test("define validates before writing", async () => {
  const store = new MeshStore(dir);
  await expect(store.define({ ...cfg, agents: [] })).rejects.toThrow(/at least one/i);
  expect(await store.load()).toEqual([]);
});

test("load on an empty/missing dir returns []", async () => {
  const store = new MeshStore(join(dir, "nope"));
  expect(await store.load()).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/mesh-store.test.ts`
Expected: FAIL — `Cannot find module './mesh-store'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mesh-store.ts
// Persists mesh definitions as .mesh/meshes/<name>.json. Only definitions are
// persisted; running state never survives a parent-process restart.
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateMeshConfig } from "./mesh-validate";
import type { MeshConfig } from "./acp/types";

export class MeshStore {
  constructor(private dir = resolve(process.cwd(), ".mesh", "meshes")) {}

  async define(config: MeshConfig): Promise<void> {
    validateMeshConfig(config);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${config.name}.json`), JSON.stringify(config, null, 2), "utf8");
  }

  async load(): Promise<MeshConfig[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: MeshConfig[] = [];
    for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
      out.push(JSON.parse(await readFile(join(this.dir, f), "utf8")) as MeshConfig);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/mesh-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-store.ts src/mesh-store.test.ts
git commit -m "feat: mesh definition store (validate + persist + load)"
```

---

## Task 4: ControlPlane.setMode convenience + export killTree

**Files:**
- Modify: `src/control-plane.ts`
- Modify: `src/acp/client.ts:21`
- Test: `src/control-plane-setmode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/control-plane-setmode.test.ts
import { test, expect } from "bun:test";
import { ControlPlane } from "./control-plane";
import { DEMO_MESH } from "./config";

test("setMode throws for an unknown agent (no connection)", () => {
  const cp = new ControlPlane(DEMO_MESH);
  expect(() => cp.setMode("ghost", "read-only")).toThrow(/no connection/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/control-plane-setmode.test.ts`
Expected: FAIL — `cp.setMode is not a function`.

- [ ] **Step 3: Implement the changes**

In `src/acp/client.ts`, change the `killTree` declaration to export it:

```ts
export function killTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
```

In `src/control-plane.ts`, add this method right after the existing `prompt(...)` method (around line 65):

```ts
  /** Switch an agent's permission/approval mode (delegates to its connection). */
  setMode(id: AgentId, modeId: string): Promise<void> {
    return this.agent(id).setMode(modeId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/control-plane-setmode.test.ts`
Expected: PASS (1 test). Also run `bun test` to confirm no regressions in existing unit tests.

- [ ] **Step 5: Commit**

```bash
git add src/control-plane.ts src/acp/client.ts src/control-plane-setmode.test.ts
git commit -m "feat: ControlPlane.setMode convenience + export killTree"
```

---

## Task 5: mesh-host bridge + subprocess entrypoint

**Files:**
- Create: `src/mesh-host.ts`
- Test: `src/mesh-host.test.ts`

The reusable `bridgeControlPlaneToSocket(cp, socket)` wires any ControlPlane-like
object to a duplex socket. The test drives it with a fake control plane over a
real Unix socket pair — no real agents needed.

- [ ] **Step 1: Write the failing test**

```ts
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

  // stop -> cp.stop() called, {t:"stopped"} sent
  client.write(encodeFrame({ t: "stop" }));
  await Bun.sleep(50);
  expect(calls).toContain("stop");
  expect(got.some((m) => m.t === "stopped")).toBe(true);

  client.destroy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/mesh-host.test.ts`
Expected: FAIL — `Cannot find module './mesh-host'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mesh-host.ts
// Subprocess body for one mesh: instantiates a ControlPlane and bridges its
// event bus + command surface to a Unix socket spoken by the parent MeshManager.
// Run directly (bun src/mesh-host.ts) with env MESH_SOCK + MESH_CONFIG.
import net from "node:net";
import { ControlPlane } from "./control-plane";
import { LineBuffer, encodeFrame, type ParentMsg } from "./protocol";
import type { MeshConfig, MeshEvent } from "./acp/types";

/** The slice of ControlPlane the bridge depends on (keeps the bridge testable). */
export interface BridgeControlPlane {
  on(listener: (e: MeshEvent) => void): () => void;
  prompt(target: string, text: string): Promise<unknown>;
  resolveDecision(requestId: string, optionId: string, by?: "human" | "timeout"): boolean;
  setMode(target: string, modeId: string): Promise<void>;
  stop(): Promise<void>;
}

export function bridgeControlPlaneToSocket(cp: BridgeControlPlane, socket: net.Socket): void {
  const send = (m: Parameters<typeof encodeFrame>[0]) => socket.write(encodeFrame(m));
  const unsubscribe = cp.on((event) => send({ t: "event", event }));

  const lb = new LineBuffer();
  socket.setEncoding("utf8");
  socket.on("data", async (chunk: string) => {
    for (const line of lb.push(chunk)) {
      let msg: ParentMsg;
      try { msg = JSON.parse(line) as ParentMsg; } catch { continue; }
      switch (msg.t) {
        case "prompt":
          cp.prompt(msg.target, msg.text).catch(() => {});
          break;
        case "resolve":
          cp.resolveDecision(msg.requestId, msg.optionId, "human");
          break;
        case "setMode":
          cp.setMode(msg.target, msg.modeId).catch(() => {});
          break;
        case "stop":
          unsubscribe();
          await cp.stop().catch(() => {});
          send({ t: "stopped" });
          break;
      }
    }
  });
  socket.on("close", () => unsubscribe());

  send({ t: "ready" });
}

// --- entrypoint (only when executed as a subprocess) ----------------------
if (import.meta.main) {
  const sockPath = process.env.MESH_SOCK;
  const configJson = process.env.MESH_CONFIG;
  if (!sockPath || !configJson) {
    console.error("mesh-host: MESH_SOCK and MESH_CONFIG are required");
    process.exit(2);
  }
  const config = JSON.parse(configJson) as MeshConfig;
  const cp = new ControlPlane(config, { debug: process.env.MESH_DEBUG === "1" });
  await cp.start();
  const socket = net.connect(sockPath);
  socket.on("connect", () => bridgeControlPlaneToSocket(cp, socket));
  socket.on("close", () => cp.stop().finally(() => process.exit(0)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/mesh-host.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-host.ts src/mesh-host.test.ts
git commit -m "feat: mesh-host subprocess bridge (ControlPlane <-> Unix socket)"
```

---

## Task 6: Echo-host fixture + MeshHostClient

**Files:**
- Create: `src/fixtures/echo-host.ts`
- Create: `src/mesh-host-client.ts`
- Test: `src/mesh-host-client.test.ts`

The fixture is a fake mesh-host that speaks the protocol without real agents, so
`MeshHostClient` (which spawns a subprocess) can be tested deterministically.

- [ ] **Step 1: Write the fixture**

```ts
// src/fixtures/echo-host.ts
// Test fixture: a fake mesh-host. Connects to MESH_SOCK, says ready, echoes
// each prompt back as a log event, and exits cleanly on stop. No real agents.
import net from "node:net";
import { LineBuffer, encodeFrame, type ParentMsg } from "../protocol";

const socket = net.connect(process.env.MESH_SOCK!);
const lb = new LineBuffer();
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(encodeFrame({ t: "ready" })));
socket.on("data", (chunk: string) => {
  for (const line of lb.push(chunk)) {
    const msg = JSON.parse(line) as ParentMsg;
    if (msg.t === "prompt") {
      socket.write(encodeFrame({ t: "event", event: { kind: "log", text: `echo:${msg.text}`, ts: "t" } }));
    } else if (msg.t === "stop") {
      socket.write(encodeFrame({ t: "stopped" }));
      socket.end();
      setTimeout(() => process.exit(0), 10);
    }
  }
});
```

- [ ] **Step 2: Write the failing test**

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/mesh-host-client.test.ts`
Expected: FAIL — `Cannot find module './mesh-host-client'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/mesh-host-client.ts
// Parent-side handle for one mesh subprocess: owns the listening Unix socket,
// spawns the mesh-host, parses its event stream, and exposes typed commands.
import net from "node:net";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { killTree } from "./acp/client";
import { LineBuffer, encodeFrame, type ChildMsg, type ParentMsg } from "./protocol";
import type { MeshConfig, MeshEvent } from "./acp/types";

export interface MeshHostClientOptions {
  name: string;
  config: MeshConfig;
  socketPath: string;
  hostScript?: string; // defaults to the real mesh-host
  debug?: boolean;
  onEvent?: (event: MeshEvent) => void;
  onExit?: (code: number) => void;
}

export class MeshHostClient {
  private server?: net.Server;
  private conn?: net.Socket;
  private child?: ReturnType<typeof Bun.spawn>;
  private readyResolve?: () => void;
  private stoppedResolve?: () => void;
  private exited = false;

  constructor(private opts: MeshHostClientOptions) {}

  get pid(): number | undefined { return this.child?.pid; }

  async start(): Promise<void> {
    await rm(this.opts.socketPath, { force: true });
    const ready = new Promise<void>((res) => { this.readyResolve = res; });

    this.server = net.createServer((sock) => this.attach(sock));
    await new Promise<void>((res) => this.server!.listen(this.opts.socketPath, res));

    const script = this.opts.hostScript ?? resolve(import.meta.dir, "mesh-host.ts");
    this.child = Bun.spawn([process.execPath, script], {
      env: {
        ...process.env,
        MESH_SOCK: this.opts.socketPath,
        MESH_CONFIG: JSON.stringify(this.opts.config),
        MESH_DEBUG: this.opts.debug ? "1" : "0",
      },
      stdin: "ignore",
      stdout: this.opts.debug ? "inherit" : "ignore",
      stderr: this.opts.debug ? "inherit" : "ignore",
    });
    this.child.exited.then((code) => {
      this.exited = true;
      this.opts.onExit?.(code);
    });

    await ready;
  }

  private attach(sock: net.Socket): void {
    this.conn = sock;
    const lb = new LineBuffer();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const line of lb.push(chunk)) {
        let msg: ChildMsg;
        try { msg = JSON.parse(line) as ChildMsg; } catch { continue; }
        if (msg.t === "ready") this.readyResolve?.();
        else if (msg.t === "event") this.opts.onEvent?.(msg.event);
        else if (msg.t === "stopped") this.stoppedResolve?.();
      }
    });
  }

  private send(msg: ParentMsg): void {
    this.conn?.write(encodeFrame(msg));
  }

  prompt(target: string, text: string): void { this.send({ t: "prompt", target, text }); }
  resolve(requestId: string, optionId: string): void { this.send({ t: "resolve", requestId, optionId }); }
  setMode(target: string, modeId: string): void { this.send({ t: "setMode", target, modeId }); }

  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.exited && this.conn) {
      const stopped = new Promise<void>((res) => { this.stoppedResolve = res; });
      this.send({ t: "stop" });
      await Promise.race([stopped, Bun.sleep(timeoutMs)]);
    }
    if (this.child?.pid && !this.exited) killTree(this.child.pid);
    this.conn?.destroy();
    this.server?.close();
    await rm(this.opts.socketPath, { force: true });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/mesh-host-client.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/fixtures/echo-host.ts src/mesh-host-client.ts src/mesh-host-client.test.ts
git commit -m "feat: MeshHostClient (spawn + supervise one mesh subprocess) + echo fixture"
```

---

## Task 7: MeshManager (deterministic lifecycle core)

**Files:**
- Create: `src/mesh-manager.ts`
- Test: `src/mesh-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/mesh-manager.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshManager } from "./mesh-manager";
import type { MeshConfig, MeshEvent } from "./acp/types";

const cfg: MeshConfig = {
  name: "echo",
  agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }],
  edges: [],
};
const FIXTURE = join(import.meta.dir, "fixtures", "echo-host.ts");

let dir: string;
let mgr: MeshManager;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mgr-"));
  mgr = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
});
afterEach(async () => { await mgr.stopAll(); await rm(dir, { recursive: true, force: true }); });

test("defineMesh persists and listMeshes shows it stopped", async () => {
  await mgr.defineMesh(cfg);
  expect(mgr.listMeshes()).toEqual([{ name: "echo", defined: true, status: "stopped" }]);
});

test("defineMesh rejects an invalid topology", async () => {
  await expect(mgr.defineMesh({ ...cfg, agents: [] })).rejects.toThrow(/at least one/i);
});

test("start -> running -> promptRouter relays events -> stop -> stopped, no orphan", async () => {
  await mgr.defineMesh(cfg);
  const events: { name: string; e: MeshEvent }[] = [];
  mgr.on((name, e) => events.push({ name, e }));

  await mgr.startMesh("echo");
  expect(mgr.listMeshes()[0]!.status).toBe("running");
  const pid = mgr.pidOf("echo")!;

  await mgr.promptRouter("echo", "ping");
  await Bun.sleep(100);
  expect(events.some((x) => x.name === "echo" && x.e.kind === "log" && (x.e as any).text === "echo:ping")).toBe(true);

  await mgr.stopMesh("echo");
  expect(mgr.listMeshes()[0]!.status).toBe("stopped");
  expect(() => process.kill(pid, 0)).toThrow();
});

test("startMesh twice errors", async () => {
  await mgr.defineMesh(cfg);
  await mgr.startMesh("echo");
  await expect(mgr.startMesh("echo")).rejects.toThrow(/already running/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/mesh-manager.test.ts`
Expected: FAIL — `Cannot find module './mesh-manager'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mesh-manager.ts
// The deterministic global control plane. Owns mesh definitions (via MeshStore)
// and supervises one MeshHostClient per running mesh. Independent of the master
// agent: callable from the TUI, tests, and e2e.
import { resolve, join } from "node:path";
import { MeshStore } from "./mesh-store";
import { MeshHostClient } from "./mesh-host-client";
import { Mesh } from "./mesh";
import type { MeshConfig, MeshEvent } from "./acp/types";

export type MeshStatus = "stopped" | "starting" | "running" | "dead";

export interface MeshManagerOptions {
  meshesDir?: string;
  runDir?: string;
  hostScript?: string;
  debug?: boolean;
}

interface Entry {
  config: MeshConfig;
  status: MeshStatus;
  client?: MeshHostClient;
}

export class MeshManager {
  private store: MeshStore;
  private runDir: string;
  private hostScript?: string;
  private debug: boolean;
  private entries = new Map<string, Entry>();
  private listeners = new Set<(name: string, e: MeshEvent) => void>();

  constructor(opts: MeshManagerOptions = {}) {
    this.store = new MeshStore(opts.meshesDir);
    this.runDir = opts.runDir ?? resolve(process.cwd(), ".mesh", "run");
    this.hostScript = opts.hostScript;
    this.debug = opts.debug ?? false;
  }

  on(listener: (name: string, e: MeshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(name: string, e: MeshEvent): void {
    for (const l of this.listeners) l(name, e);
  }

  /** Load persisted definitions into memory as stopped meshes. */
  async loadDefinitions(): Promise<void> {
    for (const config of await this.store.load()) {
      this.entries.set(config.name, { config, status: "stopped" });
    }
  }

  async defineMesh(config: MeshConfig): Promise<void> {
    await this.store.define(config); // validates first
    const existing = this.entries.get(config.name);
    if (existing && existing.status === "running") {
      throw new Error(`mesh "${config.name}" is running; stop it before redefining`);
    }
    this.entries.set(config.name, { config, status: "stopped" });
  }

  private require(name: string): Entry {
    const e = this.entries.get(name);
    if (!e) throw new Error(`no such mesh "${name}"`);
    return e;
  }

  async startMesh(name: string): Promise<void> {
    const entry = this.require(name);
    if (entry.status === "running" || entry.status === "starting") {
      throw new Error(`mesh "${name}" is already running`);
    }
    entry.status = "starting";
    const client = new MeshHostClient({
      name,
      config: entry.config,
      socketPath: join(this.runDir, `${name}.sock`),
      hostScript: this.hostScript,
      debug: this.debug,
      onEvent: (e) => this.emit(name, e),
      onExit: () => {
        if (entry.status === "running" || entry.status === "starting") {
          entry.status = "dead";
          this.emit(name, { kind: "log", text: `mesh "${name}" host exited`, ts: new Date().toISOString() });
        }
      },
    });
    entry.client = client;
    await client.start();
    entry.status = "running";
  }

  async stopMesh(name: string): Promise<void> {
    const entry = this.require(name);
    await entry.client?.stop();
    entry.client = undefined;
    entry.status = "stopped";
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((n) => this.stopMesh(n).catch(() => {})));
  }

  promptRouter(name: string, text: string): Promise<void> {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    const routerId = new Mesh(entry.config).router.id;
    entry.client.prompt(routerId, text);
    return Promise.resolve();
  }

  resolvePermission(name: string, requestId: string, optionId: string): void {
    this.require(name).client?.resolve(requestId, optionId);
  }

  setMode(name: string, agentId: string, modeId: string): void {
    this.require(name).client?.setMode(agentId, modeId);
  }

  pidOf(name: string): number | undefined {
    return this.entries.get(name)?.client?.pid;
  }

  routerOf(name: string): string {
    return new Mesh(this.require(name).config).router.id;
  }

  listMeshes(): { name: string; defined: boolean; status: MeshStatus }[] {
    return [...this.entries.values()].map((e) => ({ name: e.config.name, defined: true, status: e.status }));
  }

  configOf(name: string): MeshConfig {
    return this.require(name).config;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/mesh-manager.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-manager.ts src/mesh-manager.test.ts
git commit -m "feat: MeshManager — deterministic multi-mesh lifecycle + event bus"
```

---

## Task 8: mesh-control handlers + MCP server

**Files:**
- Create: `src/mcp/mesh-control.ts`
- Test: `src/mcp/mesh-control.test.ts`

`createMeshControlHandlers(manager)` produces text-returning wrappers (errors
become text so the LLM can self-correct). `createMeshControlServer` mirrors the
existing `createMeshServicesServer` HTTP pattern.

- [ ] **Step 1: Write the failing test**

```ts
// src/mcp/mesh-control.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshManager } from "../mesh-manager";
import { createMeshControlHandlers } from "./mesh-control";
import type { MeshConfig } from "../acp/types";

const cfg: MeshConfig = {
  name: "echo",
  agents: [{ id: "r", harness: "claude", project: "test_mesh_0", role: "router" }],
  edges: [],
};
const FIXTURE = join(import.meta.dir, "..", "fixtures", "echo-host.ts");

let dir: string;
let mgr: MeshManager;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ctl-"));
  mgr = new MeshManager({ meshesDir: join(dir, "meshes"), runDir: join(dir, "run"), hostScript: FIXTURE });
});
afterEach(async () => { await mgr.stopAll(); await rm(dir, { recursive: true, force: true }); });

test("create -> start -> list -> stop via handlers", async () => {
  const h = createMeshControlHandlers(mgr);
  expect(await h.createMesh(cfg)).toMatch(/created mesh "echo"/i);
  expect(await h.startMesh("echo")).toMatch(/started/i);
  expect(h.listMeshes()).toMatch(/echo.*running/i);
  expect(await h.stopMesh("echo")).toMatch(/stopped/i);
});

test("createMesh returns the validation error as text (no throw)", async () => {
  const h = createMeshControlHandlers(mgr);
  expect(await h.createMesh({ ...cfg, agents: [] })).toMatch(/error.*at least one/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/mcp/mesh-control.test.ts`
Expected: FAIL — `Cannot find module './mesh-control'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mcp/mesh-control.ts
// MCP server injected into the master agent: lifecycle tools that wrap the
// deterministic MeshManager. Errors are returned as text so the LLM can correct.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import type { MeshManager } from "../mesh-manager";
import type { MeshConfig } from "../acp/types";

export interface MeshControlHandlers {
  createMesh(spec: MeshConfig): Promise<string>;
  startMesh(name: string): Promise<string>;
  stopMesh(name: string): Promise<string>;
  listMeshes(): string;
}

export function createMeshControlHandlers(manager: MeshManager): MeshControlHandlers {
  const err = (e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`;
  return {
    async createMesh(spec) {
      try { await manager.defineMesh(spec); return `created mesh "${spec.name}"`; }
      catch (e) { return err(e); }
    },
    async startMesh(name) {
      try { await manager.startMesh(name); return `started "${name}"`; }
      catch (e) { return err(e); }
    },
    async stopMesh(name) {
      try { await manager.stopMesh(name); return `stopped "${name}"`; }
      catch (e) { return err(e); }
    },
    listMeshes() {
      const rows = manager.listMeshes();
      if (rows.length === 0) return "no meshes defined";
      return rows.map((r) => `- ${r.name} [${r.status}] router=${manager.routerOf(r.name)}`).join("\n");
    },
  };
}

const agentSchema = z.object({
  id: z.string(),
  harness: z.enum(["codex", "opencode", "claude"]),
  project: z.string().describe("relative working directory"),
  role: z.enum(["router", "member"]),
});
const meshSpecSchema = {
  name: z.string().describe("unique mesh name (filesystem-safe)"),
  agents: z.array(agentSchema).describe("agents; exactly one must have role 'router'"),
  edges: z.array(z.tuple([z.string(), z.string()])).describe("directed [from,to] mail edges"),
};

export interface MeshControlServer {
  readonly url: string;
  readonly port: number;
  close(): void;
}

export async function createMeshControlServer(opts: {
  handlers: MeshControlHandlers;
  port?: number;
  host?: string;
}): Promise<MeshControlServer> {
  const host = opts.host ?? "127.0.0.1";
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  const server = new McpServer({ name: "mesh-control", version: "0.1.0" });
  server.registerTool("create_mesh",
    { description: "Define a new mesh (validated + persisted; does not start it).", inputSchema: meshSpecSchema },
    async (spec) => text(await opts.handlers.createMesh(spec as unknown as MeshConfig)));
  server.registerTool("start_mesh",
    { description: "Start a defined mesh (spawns its agents).", inputSchema: { name: z.string() } },
    async ({ name }) => text(await opts.handlers.startMesh(name)));
  server.registerTool("stop_mesh",
    { description: "Stop a running mesh (terminates its agents).", inputSchema: { name: z.string() } },
    async ({ name }) => text(await opts.handlers.stopMesh(name)));
  server.registerTool("list_meshes",
    { description: "List all defined meshes and their status." },
    async () => text(opts.handlers.listMeshes()));

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const httpServer = Bun.serve({
    port: opts.port ?? 0,
    hostname: host,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
      return transport.handleRequest(req);
    },
  });

  return {
    get url() { return `http://${host}:${httpServer.port}/mcp`; },
    get port() { return httpServer.port; },
    close: () => httpServer.stop(true),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/mcp/mesh-control.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/mesh-control.ts src/mcp/mesh-control.test.ts
git commit -m "feat: mesh-control MCP (create/start/stop/list_mesh) over MeshManager"
```

---

## Task 9: Master agent module

**Files:**
- Create: `src/master-agent.ts`

Real-agent code (claude); verified via the smoke run in Task 12, not `bun test`.

- [ ] **Step 1: Implement the module**

```ts
// src/master-agent.ts
// Optional LLM control layer: a claude ACP agent whose only tools are the
// mesh-control lifecycle tools. The system runs fully without it.
import { resolve } from "node:path";
import { AcpAgentConnection } from "./acp/client";
import { resolveHarness } from "./harness";
import { createMeshControlHandlers, createMeshControlServer, type MeshControlServer } from "./mcp/mesh-control";
import type { MeshManager } from "./mesh-manager";

export class MasterAgent {
  private conn?: AcpAgentConnection;
  private mcp?: MeshControlServer;

  constructor(
    private manager: MeshManager,
    private opts: { project?: string; onUpdate?: (u: any) => void; debug?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    this.mcp = await createMeshControlServer({ handlers: createMeshControlHandlers(this.manager) });
    const spec = resolveHarness("claude");
    const cwd = resolve(process.cwd(), this.opts.project ?? ".");
    this.conn = new AcpAgentConnection({
      id: "master",
      command: spec.command,
      args: spec.args,
      cwd,
      debug: this.opts.debug ?? false,
      onUpdate: (u) => this.opts.onUpdate?.(u),
    });
    await this.conn.start();
    await this.conn.initialize();
    await this.conn.newSession([{ type: "http", name: "mesh-control", url: this.mcp.url, headers: [] }]);
  }

  /** Feed a natural-language instruction to the master agent. */
  prompt(text: string): Promise<unknown> {
    if (!this.conn) throw new Error("master agent not started");
    return this.conn.prompt(text);
  }

  async stop(): Promise<void> {
    this.conn?.kill();
    this.mcp?.close();
  }
}
```

- [ ] **Step 2: Type-check the module compiles**

Run: `bunx tsc --noEmit src/master-agent.ts 2>&1 | head -20` (informational — a clean project-wide check happens in Task 12).
Expected: no errors referencing `src/master-agent.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/master-agent.ts
git commit -m "feat: optional MasterAgent (claude) wired to mesh-control MCP"
```

---

## Task 10: Line editor (pure input component)

**Files:**
- Create: `src/tui/line-editor.ts`
- Test: `src/tui/line-editor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/line-editor.test.ts
import { test, expect } from "bun:test";
import { LineEditor } from "./line-editor";

test("types characters and submits on Enter", () => {
  const ed = new LineEditor();
  for (const c of "hello") ed.handle(c);
  expect(ed.value).toBe("hello");
  expect(ed.handle("\r")).toBe("hello"); // Enter returns the submitted line
  expect(ed.value).toBe("");             // and clears
});

test("backspace deletes the last character", () => {
  const ed = new LineEditor();
  for (const c of "abc") ed.handle(c);
  ed.handle("\x7f");
  expect(ed.value).toBe("ab");
});

test("non-submit keys return null", () => {
  const ed = new LineEditor();
  expect(ed.handle("x")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/line-editor.test.ts`
Expected: FAIL — `Cannot find module './line-editor'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tui/line-editor.ts
// Minimal single-line input buffer for the TUI. Returns the submitted string on
// Enter, otherwise null. Pure and unit-testable (no terminal I/O).
export class LineEditor {
  private buf = "";
  get value(): string { return this.buf; }

  /** Feed one input character. Returns the line on Enter, else null. */
  handle(ch: string): string | null {
    if (ch === "\r" || ch === "\n") {
      const line = this.buf;
      this.buf = "";
      return line;
    }
    if (ch === "\x7f" || ch === "\b") {
      this.buf = this.buf.slice(0, -1);
      return null;
    }
    if (ch >= " ") this.buf += ch;
    return null;
  }

  clear(): void { this.buf = ""; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/line-editor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/line-editor.ts src/tui/line-editor.test.ts
git commit -m "feat: pure single-line input editor for the TUI"
```

---

## Task 11: TUI — master chat + mesh list + Router chat pane

**Files:**
- Modify: `src/tui/app.ts` (full rewrite)

Two contexts: **top** (master-agent chat + mesh list) and **mesh** (Router chat
pane, fullscreen-toggle). Verified manually (consistent with PoC point 6, which
is a manual snapshot).

- [ ] **Step 1: Replace `src/tui/app.ts` with the new implementation**

```ts
// src/tui/app.ts
// Interactive TUI over MeshManager + an optional MasterAgent. Two contexts:
//   top:  chat with the master agent + a live mesh list
//   mesh: chat with the selected mesh's Router (primary pane; 'f' fullscreen)
// Permission escalations from a running mesh render and are resolvable by key.
import type { MeshManager } from "../mesh-manager";
import type { MasterAgent } from "../master-agent";
import type { MeshEvent } from "../acp/types";
import { LineEditor } from "./line-editor";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", cyan: "\x1b[36m", gray: "\x1b[90m",
};

interface Pending { meshName: string; requestId: string; agent: string; question: string; options: { id: string; name: string; kind?: string }[]; }

export class Tui {
  private editor = new LineEditor();
  private context: "top" | "mesh" = "top";
  private selectedMesh = 0;
  private fullscreen = false;
  private masterLog: string[] = [];          // master-agent conversation lines
  private meshChat = new Map<string, string[]>(); // per-mesh router conversation
  private activity: string[] = [];
  private pending: Pending[] = [];
  private dirty = true;
  private renderTimer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private origConsole?: { log: any; error: any; warn: any };

  constructor(private manager: MeshManager, private master?: MasterAgent) {}

  start(): void {
    this.origConsole = { log: console.log, error: console.error, warn: console.warn };
    console.log = () => {}; console.error = () => {}; console.warn = () => {};

    this.unsubscribe = this.manager.on((name, e) => this.ingest(name, e));

    process.stdout.write("\x1b[?1049h\x1b[?25l");
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d: string) => this.onKey(d));
    }
    this.renderTimer = setInterval(() => { if (this.dirty) { this.dirty = false; this.render(); } }, 100);
    this.render();
  }

  stop(): void {
    this.renderTimer && clearInterval(this.renderTimer);
    this.unsubscribe?.();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (this.origConsole) { console.log = this.origConsole.log; console.error = this.origConsole.error; console.warn = this.origConsole.warn; }
  }

  private meshNames(): string[] { return this.manager.listMeshes().map((m) => m.name); }
  private currentMesh(): string | undefined { return this.meshNames()[this.selectedMesh]; }

  private summarize(update: any): string {
    const k = update?.sessionUpdate ?? "?";
    if (k === "agent_message_chunk" || k === "agent_thought_chunk")
      return String(update?.content?.text ?? "").replace(/\s+/g, " ");
    if (k === "tool_call" || k === "tool_call_update")
      return `[tool] ${update?.title ?? ""} ${update?.status ?? ""}`;
    return k;
  }

  private ingest(name: string, e: MeshEvent): void {
    this.dirty = true;
    if (e.kind === "update") {
      const line = this.summarize(e.update);
      const log = this.meshChat.get(name) ?? [];
      log.push(`${C.dim}${e.agent}:${C.reset} ${line}`);
      if (log.length > 200) log.shift();
      this.meshChat.set(name, log);
    } else if (e.kind === "permission") {
      this.pending.push({ meshName: name, requestId: e.requestId, agent: e.agent, question: e.question, options: e.options });
    } else if (e.kind === "permission_resolved") {
      this.pending = this.pending.filter((p) => p.requestId !== e.requestId);
      this.activity.push(`[${name}] permission ${e.requestId.slice(0, 8)} -> ${e.optionId} (${e.by})`);
    } else if (e.kind === "mail") {
      this.activity.push(`[${name}] mail ${e.from} -> ${e.to}: ${e.body.slice(0, 40)}`);
    } else if (e.kind === "interrupt") {
      this.activity.push(`[${name}] interrupt ${e.from} -> ${e.target}`);
    } else if (e.kind === "log") {
      this.activity.push(`[${name}] ${e.text}`);
    }
    if (this.activity.length > 200) this.activity.shift();
  }

  private onKey(d: string): void {
    for (const ch of d) {
      // Ctrl-C always quits.
      if (ch === "\x03") { this.quit(); return; }

      // Permission resolution (digits) takes priority when one is pending for view.
      if (ch >= "1" && ch <= "9" && this.editor.value === "") {
        const p = this.visiblePending();
        const opt = p?.options[Number(ch) - 1];
        if (p && opt) { this.manager.resolvePermission(p.meshName, p.requestId, opt.id); this.dirty = true; continue; }
      }

      if (this.context === "top") this.topKey(ch);
      else this.meshKey(ch);
    }
  }

  private topKey(ch: string): void {
    if (ch === "\x1b") return;                       // esc: no-op at top
    if (ch === "\t") { this.cycleMesh(); return; }
    if (ch === "\x12") { void this.refreshDefinitions(); return; } // Ctrl-R reload
    const submitted = this.editor.handle(ch);
    this.dirty = true;
    if (submitted === "/enter") { this.enterMesh(); return; }
    if (submitted != null && submitted.length > 0) this.sendToMaster(submitted);
  }

  private meshKey(ch: string): void {
    if (ch === "\x1b") { this.context = "top"; this.fullscreen = false; this.dirty = true; return; }
    if (ch === "\x06") { this.fullscreen = !this.fullscreen; this.dirty = true; return; } // Ctrl-F
    const submitted = this.editor.handle(ch);
    this.dirty = true;
    if (submitted != null && submitted.length > 0) this.sendToRouter(submitted);
  }

  private cycleMesh(): void {
    const n = this.meshNames().length;
    if (n > 0) { this.selectedMesh = (this.selectedMesh + 1) % n; this.dirty = true; }
  }

  private enterMesh(): void {
    const name = this.currentMesh();
    if (!name) return;
    if (this.manager.listMeshes()[this.selectedMesh]?.status !== "running") {
      this.activity.push(`cannot enter "${name}": not running`);
      return;
    }
    this.context = "mesh";
    this.dirty = true;
  }

  private sendToMaster(text: string): void {
    if (!this.master) { this.masterLog.push(`${C.yellow}(no master agent configured)${C.reset}`); return; }
    this.masterLog.push(`${C.bold}you:${C.reset} ${text}`);
    this.master.prompt(text).catch((e) => this.masterLog.push(`${C.red}master error: ${String(e)}${C.reset}`));
  }

  private sendToRouter(text: string): void {
    const name = this.currentMesh();
    if (!name) return;
    const log = this.meshChat.get(name) ?? [];
    log.push(`${C.bold}you -> router:${C.reset} ${text}`);
    this.meshChat.set(name, log);
    this.manager.promptRouter(name, text).catch((e) => log.push(`${C.red}router error: ${String(e)}${C.reset}`));
  }

  private async refreshDefinitions(): Promise<void> {
    await this.manager.loadDefinitions().catch(() => {});
    this.dirty = true;
  }

  private visiblePending(): Pending | undefined {
    if (this.context === "mesh") {
      const name = this.currentMesh();
      return this.pending.find((p) => p.meshName === name);
    }
    return this.pending[0];
  }

  private quit(): void {
    this.stop();
    Promise.allSettled([this.manager.stopAll(), this.master?.stop()]).finally(() => process.exit(0));
  }

  private render(): void {
    const out: string[] = ["\x1b[2J\x1b[H"];
    const meshes = this.manager.listMeshes();

    if (this.context === "top") {
      out.push(`${C.bold}${C.cyan}Agent Mesh — Control${C.reset}  ${C.dim}(master agent + mesh manager)${C.reset}`);
      out.push("");
      out.push(`${C.bold}Master agent${C.reset} ${C.dim}(type an instruction, Enter to send; type "/enter" to open selected mesh)${C.reset}`);
      for (const l of this.masterLog.slice(-8)) out.push(`  ${l}`);
      out.push("");
      out.push(`${C.bold}Meshes${C.reset} ${C.dim}(Tab to select · Ctrl-R reload defs)${C.reset}`);
      if (meshes.length === 0) out.push(`  ${C.gray}(none — ask the master agent to create one)${C.reset}`);
      meshes.forEach((m, i) => {
        const sel = i === this.selectedMesh ? `${C.bold}▸${C.reset}` : " ";
        const col = m.status === "running" ? C.green : m.status === "dead" ? C.red : m.status === "starting" ? C.yellow : C.gray;
        out.push(`${sel} ${C.bold}${m.name.padEnd(16)}${C.reset} ${col}●${C.reset} ${m.status}`);
      });
    } else {
      const name = this.currentMesh() ?? "?";
      const chat = this.meshChat.get(name) ?? [];
      out.push(`${C.bold}${C.cyan}Mesh "${name}" — Router chat${C.reset}  ${C.dim}(esc back · Ctrl-F ${this.fullscreen ? "windowed" : "fullscreen"})${C.reset}`);
      out.push("");
      const lines = this.fullscreen ? chat.slice(-30) : chat.slice(-14);
      if (lines.length === 0) out.push(`  ${C.gray}(no messages yet — type to talk to the router)${C.reset}`);
      for (const l of lines) out.push(`  ${l}`);
    }

    const p = this.visiblePending();
    if (p) {
      out.push("");
      out.push(`${C.bold}${C.yellow}⚠ Permission${C.reset} [${p.meshName}] ${p.agent}: ${C.bold}${p.question}${C.reset}`);
      out.push("   " + p.options.map((o, i) => `${C.bold}${i + 1}${C.reset}) ${o.name}`).join("   "));
    }

    if (!this.fullscreen) {
      out.push("");
      out.push(`${C.bold}Activity${C.reset}`);
      for (const l of this.activity.slice(-5)) out.push(`  ${C.gray}${l}${C.reset}`);
    }

    out.push("");
    out.push(`${C.bold}> ${C.reset}${this.editor.value}${C.dim}▌${C.reset}`);
    out.push(`${C.dim}keys: digits decide permission · Ctrl-C quit${C.reset}`);

    process.stdout.write(out.join("\n"));
  }
}
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit 2>&1 | grep -E "tui/app|line-editor" | head -20`
Expected: no errors for these files. (Full project check in Task 12.)

- [ ] **Step 3: Commit**

```bash
git add src/tui/app.ts
git commit -m "feat: interactive TUI — master chat, mesh list, router chat pane"
```

---

## Task 12: Wire main.ts, adapt e2e.ts, add lifecycle smoke

**Files:**
- Modify: `src/main.ts` (full rewrite)
- Modify: `src/e2e.ts`
- Create: `src/flows/mesh-lifecycle.smoke.ts`

- [ ] **Step 1: Rewrite `src/main.ts`**

```ts
// src/main.ts
// Boot the MeshManager + an optional MasterAgent + interactive TUI. The demo
// mesh definition is seeded so there is something to start on first run.
import { MeshManager } from "./mesh-manager";
import { MasterAgent } from "./master-agent";
import { DEMO_MESH } from "./config";
import { Tui } from "./tui/app";

const manager = new MeshManager();
await manager.loadDefinitions();
// Seed the demo definition if absent (idempotent; validated on define).
if (!manager.listMeshes().some((m) => m.name === DEMO_MESH.name)) {
  await manager.defineMesh(DEMO_MESH);
}

const master = new MasterAgent(manager);
const tui = new Tui(manager, master);
tui.start();

process.on("SIGINT", () => {
  tui.stop();
  Promise.allSettled([manager.stopAll(), master.stop()]).finally(() => process.exit(0));
});

await master.start().catch(() => {
  // Master agent is optional; the manager + TUI still work without it.
});
```

- [ ] **Step 2: Adapt `src/e2e.ts` to drive through MeshManager**

Replace the control-plane construction and usage. Change the imports and the
`cp` setup at the top:

```ts
// src/e2e.ts  (replace lines that import/instantiate ControlPlane)
import { resolve } from "node:path";
import { rm, stat } from "node:fs/promises";
import { MeshManager } from "./mesh-manager";
import { DEMO_MESH } from "./config";

const probe = resolve(process.cwd(), "test_mesh_0", "e2e-probe.txt");
await rm(probe, { force: true });

const manager = new MeshManager();
await manager.defineMesh(DEMO_MESH);
```

Replace every `cp.on(` with `manager.on(` and adjust the listener signature to
`(meshName, e) => { ... }` (ignore `meshName`). Replace the driver helpers:

```ts
// prompt an agent inside the demo mesh via the manager's host client
const hostPrompt = (id: string, text: string) => {
  // MeshManager exposes promptRouter for the router; for members, use the
  // generic host client through a small helper added below.
  return manager.promptAgent(DEMO_MESH.name, id, text);
};
```

Add a `promptAgent` passthrough to `MeshManager` (in `src/mesh-manager.ts`),
next to `promptRouter`:

```ts
  promptAgent(name: string, agentId: string, text: string): void {
    const entry = this.require(name);
    if (entry.status !== "running" || !entry.client) throw new Error(`mesh "${name}" is not running`);
    entry.client.prompt(agentId, text);
  }
```

Then update the e2e body: replace `await cp.start()` with
`await manager.startMesh(DEMO_MESH.name)`; replace `cp.prompt(id, text)` and
`promptWithTimeout` internals with `hostPrompt(id, text)` (note: host prompts are
fire-and-forget, so assertions key off events, which they already do); replace
`cp.agent("codex-1").setMode(m)` with `manager.setMode(DEMO_MESH.name, "codex-1", m)`;
replace `cp.resolveDecision(reqId, optId, "human")` with
`manager.resolvePermission(DEMO_MESH.name, reqId, optId)`; and replace
`await cp.stop()` with `await manager.stopAll()`.

Because host prompts no longer return a stopReason, simplify point 5: assert on
`interruptSeen` plus observed codex streaming stopping (drop `codexStop`
reporting; keep `interruptSeen`). Keep the global watchdog and the 5-point report.

- [ ] **Step 3: Create the lifecycle smoke test (real agents, manual)**

```ts
// src/flows/mesh-lifecycle.smoke.ts
// Manual smoke: define -> start -> prompt router -> stop, with real agents.
// Run: bun run src/flows/mesh-lifecycle.smoke.ts
import { MeshManager } from "../mesh-manager";
import { DEMO_MESH } from "../config";

const manager = new MeshManager();
let routerSpoke = false;
manager.on((name, e) => {
  if (e.kind === "update" && e.agent === DEMO_MESH.router?.id) routerSpoke = true;
  if (e.kind === "update") console.log(`[${name}] ${e.agent}`, (e.update as any)?.sessionUpdate);
});

await manager.defineMesh(DEMO_MESH);
console.log("defined:", manager.listMeshes());
await manager.startMesh(DEMO_MESH.name);
console.log("started:", manager.listMeshes());

await manager.promptRouter(DEMO_MESH.name, "Say hello in one short sentence, then stop.");
await Bun.sleep(20_000);

await manager.stopMesh(DEMO_MESH.name);
console.log("stopped:", manager.listMeshes());
console.log(routerSpoke ? "PASS: router responded" : "WARN: no router activity observed");
process.exit(0);
```

Note: `DEMO_MESH.router` is not a field; compute the router id inline instead:

```ts
import { Mesh } from "../mesh";
const routerId = new Mesh(DEMO_MESH).router.id;
// ...and compare e.agent === routerId
```

- [ ] **Step 4: Type-check the whole project**

Run: `bunx tsc --noEmit 2>&1 | head -30`
Expected: no errors.

- [ ] **Step 5: Run the full unit suite**

Run: `bun test`
Expected: PASS — all unit tests across protocol, validate, store, setmode, host bridge, host client, manager, mesh-control, line-editor (plus the pre-existing mailbox/mesh/harness tests).

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/e2e.ts src/flows/mesh-lifecycle.smoke.ts src/mesh-manager.ts
git commit -m "feat: boot MeshManager+MasterAgent+TUI; e2e via manager; lifecycle smoke"
```

- [ ] **Step 7: Manual verification (real agents)**

Run: `bun run src/flows/mesh-lifecycle.smoke.ts`
Expected: prints `defined` → `started` (status running) → router activity →
`stopped` (status stopped) → `PASS: router responded`.

Run: `bun run e2e`
Expected: the 5-point report still passes (1+2 spawn, 3 mailbox, 4 permission, 5 interrupt) now driven through `MeshManager`.

Run: `bun run mesh` and verify manually: master-agent chat accepts an
instruction like "create a mesh named demo2 with a claude router and a codex
member, then start it"; the mesh list updates; Tab + `/enter` opens the Router
chat; typing talks to the router; Ctrl-F toggles fullscreen; esc returns; a
permission prompt is resolvable by digit; Ctrl-C exits with **no orphan
processes** (`pgrep -af codex-acp` / `opencode` / `claude-agent-acp` empty).

---

## Task 13: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the architecture + run sections**

Update the architecture diagram to show the parent (`MeshManager` + optional
`MasterAgent` + TUI) supervising one `mesh-host` subprocess per mesh over a Unix
socket. Document the new run flow:

```markdown
**Interactive control** — master agent + multi-mesh manager + chat TUI:

    bun run mesh

Top context: type instructions to the master agent (it has create/start/stop/
list_mesh tools); Tab selects a mesh, "/enter" opens it. Mesh context: chat with
the Router; Ctrl-F fullscreen; esc back. Digits resolve permission prompts;
Ctrl-C quits (reaps all mesh subprocesses).

**Lifecycle smoke** (real agents): `bun run src/flows/mesh-lifecycle.smoke.ts`
```

Add a note that mesh definitions persist under `.mesh/meshes/<name>.json` and
that each running mesh is an isolated subprocess (so a crash is contained, and
`stop` reaps the whole process tree).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document master agent + multi-mesh subprocess model"
```

---

## Self-review notes

- **Spec coverage:** master agent = Tasks 8/9; deterministic lifecycle independent of master = Task 7 (MeshManager) + Task 8 handlers; validation rules = Task 2; persistence = Task 3; process-per-mesh + Unix socket + protocol = Tasks 1/5/6; permission escalation across the boundary = bridge `resolve` (Task 5) + MeshManager.resolvePermission (Task 7) + TUI (Task 11); Router chat pane + fullscreen + master chat = Task 11; no-orphan guarantee on stop = killTree path (Tasks 4/6) asserted in Tasks 6/7; e2e + smoke = Task 12; YAGNI scope (lifecycle-only master, router-only chat, definition-only persistence) respected throughout.
- **Type consistency:** `MeshHostClient` methods `prompt/resolve/setMode/stop` match the `ParentMsg` union and the `BridgeControlPlane` interface; `MeshManager` uses `promptRouter`/`promptAgent`/`resolvePermission`/`setMode`/`stopAll` consistently across Tasks 7, 8, 11, 12; `MeshEvent` is the single event type flowing child→parent→TUI.
- **No placeholders:** every code/test step contains full code; commands have expected output.
</content>
