# New-Session-Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator switch a single agent — or every agent in a mesh — to a fresh ACP session (`session/new`), correctly handling running and not-running agents.

**Architecture:** Running agents reuse the existing `forceFresh` respawn path (kill subprocess → `session/new`, persist new id). Not-running agents are never spawned; only their persisted `sessionId` is invalidated so their next wake starts fresh. A synthetic `__session_reset__` transcript update renders a "new session" divider. Plumbing mirrors the existing `setMode` chain: client → api → gateway → manager → host-client → mesh-host → control-plane.

**Tech Stack:** Bun, TypeScript, React, Playwright (e2e), NDJSON Unix-socket control protocol, ACP.

**Spec:** `docs/superpowers/specs/2026-06-09-new-session-switch-design.md`

---

### Task 1: session-storage — invalidate persisted session ids

**Files:**
- Modify: `src/session-storage.ts`
- Test: `src/session-storage.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/session-storage.test.ts`:

```ts
import { clearAgentSession, clearAllAgentSessions } from "./session-storage";

test("clearAgentSession blanks only the target's sessionId, keeps other fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "sess-clear-"));
  try {
    await writeSessionState(root, "m", {
      meshExpectedAlive: true,
      agents: {
        a: { sessionId: "sid-a", cwd: "/x", harness: "codex", mode: "build", model: "kimi-k2", effort: "high" },
        b: { sessionId: "sid-b", cwd: "/y", harness: "claude" },
      },
    });
    const state = await clearAgentSession(root, "m", "a");
    expect(state.agents.a).toEqual({ sessionId: "", cwd: "/x", harness: "codex", mode: "build", model: "kimi-k2", effort: "high" });
    expect(state.agents.b.sessionId).toBe("sid-b");
    expect(state.meshExpectedAlive).toBe(true);
    expect((await readSessionState(root, "m")).agents.a.sessionId).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clearAgentSession is a no-op when the agent has no record", async () => {
  const root = await mkdtemp(join(tmpdir(), "sess-clear-none-"));
  try {
    await writeSessionState(root, "m", { meshExpectedAlive: true, agents: {} });
    const state = await clearAgentSession(root, "m", "ghost");
    expect(state.agents.ghost).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clearAllAgentSessions blanks every sessionId, preserves meshExpectedAlive", async () => {
  const root = await mkdtemp(join(tmpdir(), "sess-clear-all-"));
  try {
    await writeSessionState(root, "m", {
      meshExpectedAlive: false,
      agents: {
        a: { sessionId: "sid-a", cwd: "/x", harness: "codex" },
        b: { sessionId: "sid-b", cwd: "/y", harness: "claude" },
      },
    });
    const state = await clearAllAgentSessions(root, "m");
    expect(state.agents.a.sessionId).toBe("");
    expect(state.agents.b.sessionId).toBe("");
    expect(state.meshExpectedAlive).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

Ensure the test file already imports `mkdtemp`, `rm`, `tmpdir`, `join`, `readSessionState`, `writeSessionState` (it does for existing tests — reuse them; only add the new `clear*` import).

- [ ] **Step 2: Run, verify it fails**

Run: `bun test src/session-storage.test.ts`
Expected: FAIL — `clearAgentSession`/`clearAllAgentSessions` are not exported.

- [ ] **Step 3: Implement**

Append to `src/session-storage.ts` (after `setMeshExpectedAlive`):

```ts
/** Invalidate one agent's persisted ACP session id (keeps cwd/harness/model/mode/effort)
 *  so the agent's NEXT spawn starts a fresh session instead of resuming. No-op if absent.
 *  Does NOT touch meshExpectedAlive — clearing a session must never resurrect a stopped mesh. */
export async function clearAgentSession(runDir: string, meshName: string, agentId: AgentId): Promise<MeshSessionState> {
  const state = await readSessionState(runDir, meshName);
  const rec = state.agents[agentId];
  if (rec) rec.sessionId = "";
  await writeSessionState(runDir, meshName, state);
  return state;
}

/** Invalidate every agent's persisted session id (mesh-wide fresh start). */
export async function clearAllAgentSessions(runDir: string, meshName: string): Promise<MeshSessionState> {
  const state = await readSessionState(runDir, meshName);
  for (const rec of Object.values(state.agents)) rec.sessionId = "";
  await writeSessionState(runDir, meshName, state);
  return state;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/session-storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-storage.ts src/session-storage.test.ts
git commit -m "feat(session-storage): clearAgentSession/clearAllAgentSessions to invalidate resume ids"
```

---

### Task 2: protocol — new daemon frames

**Files:**
- Modify: `src/protocol.ts`

- [ ] **Step 1: Add frames and bump version**

In `src/protocol.ts`, bump the version:

```ts
export const PROTO_VERSION = 8;
```

Add two entries to the `ParentMsg` union (after the `interrupt` line):

```ts
  | { t: "newSession"; target: string }
  | { t: "newAllSessions" }
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS (no usages yet; the switch statements get the cases in later tasks — tsc does not require exhaustive switches here).

- [ ] **Step 3: Commit**

```bash
git add src/protocol.ts
git commit -m "feat(protocol): add newSession/newAllSessions frames; bump PROTO_VERSION to 8"
```

---

### Task 3: control-plane — newSession / newAllSessions

**Files:**
- Modify: `src/control-plane.ts`
- Test: `src/control-plane-newsession.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `src/control-plane-newsession.test.ts`. Reuse the `ResumeConnection` fake pattern from `control-plane-setmode.test.ts` (copy the class in — the engineer may read tasks out of order, so the full fake is below):

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import type { AcpAgentConnection, AcpConnectionOptions } from "./acp/client";
import type { MeshConfig } from "./acp/types";
import { ControlPlane } from "./control-plane";
import { readSessionState, writeSessionState } from "./session-storage";

function sessionSetup(sessionId: string): unknown {
  return { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] } };
}

class ResumeConnection {
  supportsLoadSession = false;
  newSessionCount = 0;
  loadCalls: any[] = [];
  prompts: string[] = [];
  kills = 0;
  constructor(readonly opts: AcpConnectionOptions, private behavior: { supportsLoadSession?: boolean } = {}) {}
  async start(): Promise<void> {}
  async initialize(): Promise<unknown> {
    this.supportsLoadSession = this.behavior.supportsLoadSession === true;
    return { agentCapabilities: { loadSession: this.supportsLoadSession, promptCapabilities: { image: true } } };
  }
  async newSession(): Promise<unknown> {
    this.newSessionCount++;
    return sessionSetup(`new-${this.opts.id}-${this.newSessionCount}`);
  }
  async loadSession(sessionId: string, cwd: string, mcpServers: any[]): Promise<unknown> {
    this.loadCalls.push({ sessionId, cwd, mcpServers });
    return sessionSetup(sessionId);
  }
  async prompt(text: string): Promise<unknown> { this.prompts.push(text); return { stopReason: "end_turn" }; }
  async steerPrompt(text: string): Promise<unknown> { return this.prompt(text); }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async cancel(): Promise<void> {}
  kill(): void { this.kills++; }
}

test("newSession on a live agent respawns fresh and replaces the stored session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-newsession-live-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "ns-live",
    agents: [{ id: "router", harness: "codex", project: root, role: "router" }],
    edges: [],
  };
  const created: ResumeConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const c = new ResumeConnection(opts, { supportsLoadSession: true });
      created.push(c);
      return c as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    const firstSid = (await readSessionState(runDir, config.name)).agents.router.sessionId;
    await cp.newSession("router");
    expect(created).toHaveLength(2);           // old killed, new spawned
    expect(created[0].kills).toBeGreaterThan(0);
    expect(created[1].newSessionCount).toBe(1); // fresh, not loaded
    expect(created[1].loadCalls).toEqual([]);
    const nextSid = (await readSessionState(runDir, config.name)).agents.router.sessionId;
    expect(nextSid).not.toBe(firstSid);
    expect(events).toContainEqual(expect.objectContaining({ kind: "update", agent: "router", update: { sessionUpdate: "__session_reset__" } }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("newSession on a not-running agent clears the stored id WITHOUT spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-newsession-dead-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "ns-dead",
    agents: [{ id: "router", harness: "kimi", project: root, role: "router" }],
    edges: [],
  };
  // meshExpectedAlive:false => start() spawns nothing; agent is "dead".
  await writeSessionState(runDir, config.name, {
    meshExpectedAlive: false,
    agents: { router: { sessionId: "old-session", cwd: root, harness: "kimi", mode: "build" } },
  });
  const created: ResumeConnection[] = [];
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => {
      const c = new ResumeConnection(opts, { supportsLoadSession: true });
      created.push(c);
      return c as unknown as AcpAgentConnection;
    },
  });
  const events: any[] = [];
  cp.on((e) => events.push(e));
  try {
    await cp.start();
    expect(created).toHaveLength(0);
    await cp.newSession("router");
    expect(created).toHaveLength(0); // never resurrected
    const rec = (await readSessionState(runDir, config.name)).agents.router;
    expect(rec.sessionId).toBe("");   // invalidated
    expect(rec.mode).toBe("build");   // other fields kept
    expect(events).toContainEqual(expect.objectContaining({ kind: "update", agent: "router", update: { sessionUpdate: "__session_reset__" } }));
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("newAllSessions resets every agent (mix of live and not-running)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-newsession-all-"));
  const runDir = join(root, "run");
  const config: MeshConfig = {
    name: "ns-all",
    agents: [
      { id: "router", harness: "codex", project: root, role: "router" },
      { id: "m1", harness: "claude", project: root, role: "member", lazy: true },
    ],
    edges: [{ from: "router", to: "m1" }],
  };
  const cp = new ControlPlane(config, {
    mailboxPath: join(root, "mailbox.ndjson"),
    sessionRunDir: runDir,
    connectionFactory: (opts) => new ResumeConnection(opts, { supportsLoadSession: true }) as unknown as AcpAgentConnection,
  });
  try {
    await cp.start(); // router spawns; m1 is lazy/cold
    await cp.newAllSessions();
    const state = await readSessionState(runDir, config.name);
    // router got a fresh persisted id (non-empty, regenerated); m1 had no live session so stays empty/absent.
    expect(state.agents.router.sessionId).toMatch(/^new-router-/);
  } finally {
    await cp.stop();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `bun test src/control-plane-newsession.test.ts`
Expected: FAIL — `cp.newSession`/`cp.newAllSessions` are not functions.

- [ ] **Step 3: Implement**

In `src/control-plane.ts`, add the `clearAgentSession` import:

```ts
import { readSessionState, setMeshExpectedAlive, updateAgentSession, clearAgentSession, type MeshSessionState } from "./session-storage";
```

Add these methods right after `interrupt(...)` (around line 172):

```ts
  /** Operator-initiated "switch to a fresh ACP session" for one agent.
   *  Running agents respawn fresh (forceFresh => kill + session/new + persist new id).
   *  Not-running agents (dead/cold/lazy) are NEVER spawned here — only their persisted
   *  session id is invalidated so their NEXT wake starts fresh. */
  async newSession(id: AgentId): Promise<void> {
    const a = this.mesh.agent(id);
    if (!a) throw new Error(`no such agent "${id}"`);
    const status = this.mesh.status(id);
    const live = this.conns.has(id) && status !== "dead" && status !== "cold";
    if (live) {
      await this.ensureSpawned(id, { manual: true, forceFresh: true, drainPendingMail: false });
    } else if (this.sessionRunDir) {
      this.sessionState = await clearAgentSession(this.sessionRunDir, this.mesh.name, id);
    }
    this.emit({ kind: "update", agent: id, update: { sessionUpdate: "__session_reset__" }, ts: now() });
  }

  /** One-click: switch every agent in the mesh to a fresh session. */
  async newAllSessions(): Promise<void> {
    for (const a of this.mesh.agents) {
      await this.newSession(a.id).catch((err) => this.log(`newSession(${a.id}) failed: ${String(err)}`));
    }
  }
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/control-plane-newsession.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/control-plane.ts src/control-plane-newsession.test.ts
git commit -m "feat(control-plane): newSession/newAllSessions (respawn live, invalidate idle)"
```

---

### Task 4: mesh-host — bridge interface + frame handlers

**Files:**
- Modify: `src/mesh-host.ts`

- [ ] **Step 1: Extend the BridgeControlPlane interface**

In `src/mesh-host.ts`, add to `interface BridgeControlPlane` (after `interrupt`):

```ts
  newSession(target: string): Promise<void>;
  newAllSessions(): Promise<void>;
```

- [ ] **Step 2: Handle the new frames**

In the `handle()` switch (after the `interrupt` case):

```ts
      case "newSession":
        this.cp.newSession(msg.target).catch(() => {});
        break;
      case "newAllSessions":
        this.cp.newAllSessions().catch(() => {});
        break;
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS. `ControlPlane` already implements both methods (Task 3), so it still satisfies `BridgeControlPlane`.

- [ ] **Step 4: Commit**

```bash
git add src/mesh-host.ts
git commit -m "feat(mesh-host): route newSession/newAllSessions frames to control-plane"
```

---

### Task 5: mesh-host-client — send methods

**Files:**
- Modify: `src/mesh-host-client.ts`

- [ ] **Step 1: Add send methods**

After the `interrupt(...)` method (around line 212):

```ts
  newSession(target: string): void { this.send({ t: "newSession", target }); }
  newAllSessions(): void { this.send({ t: "newAllSessions" }); }
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/mesh-host-client.ts
git commit -m "feat(mesh-host-client): newSession/newAllSessions RPC senders"
```

---

### Task 6: mesh-manager — running→daemon, stopped→on-disk

**Files:**
- Modify: `src/mesh-manager.ts`
- Test: `src/mesh-manager.test.ts`

- [ ] **Step 1: Write failing test (stopped-mesh path)**

Add to `src/mesh-manager.test.ts` (it already constructs a `MeshManager` with a temp root + `MESH_HOST_SCRIPT` fake in other tests — model the new test on an existing stopped-mesh test; the key assertion is the on-disk effect). Use the manager's runDir, which is `join(root, "run")`:

```ts
import { readSessionState, writeSessionState } from "./session-storage";

test("newAllSessions on a stopped mesh blanks persisted session ids on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "mgr-newsession-"));
  try {
    const mgr = new MeshManager({ root });
    await mgr.defineMesh({
      name: "m",
      agents: [{ id: "router", harness: "codex", project: ".", role: "router" }],
      edges: [],
    });
    const runDir = join(root, "run");
    await writeSessionState(runDir, "m", {
      meshExpectedAlive: true,
      agents: { router: { sessionId: "sid", cwd: ".", harness: "codex" } },
    });
    await mgr.newAllSessions("m"); // mesh is stopped → writes disk directly
    expect((await readSessionState(runDir, "m")).agents.router.sessionId).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newAgentSession on a stopped mesh blanks one agent's id on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "mgr-newsession-one-"));
  try {
    const mgr = new MeshManager({ root });
    await mgr.defineMesh({
      name: "m",
      agents: [{ id: "router", harness: "codex", project: ".", role: "router" }],
      edges: [],
    });
    const runDir = join(root, "run");
    await writeSessionState(runDir, "m", {
      meshExpectedAlive: true,
      agents: { router: { sessionId: "sid", cwd: ".", harness: "codex" } },
    });
    await mgr.newAgentSession("m", "router");
    expect((await readSessionState(runDir, "m")).agents.router.sessionId).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

Confirm `mkdtemp`, `rm`, `tmpdir`, `join`, and `MeshManager` are already imported in the test file; add the `readSessionState`/`writeSessionState` import.

- [ ] **Step 2: Run, verify it fails**

Run: `bun test src/mesh-manager.test.ts`
Expected: FAIL — `mgr.newAllSessions`/`mgr.newAgentSession` are not functions.

- [ ] **Step 3: Implement**

In `src/mesh-manager.ts`, add the import:

```ts
import { clearAgentSession, clearAllAgentSessions } from "./session-storage";
```

Add these methods (after `interruptAgent`):

```ts
  /** Switch one agent to a fresh session. Running mesh → tell the daemon; otherwise
   *  invalidate the persisted id on disk so the next start spawns fresh. */
  async newAgentSession(name: string, agentId: string): Promise<void> {
    const entry = this.require(name);
    if (!entry.config.agents.some((a) => a.id === agentId)) throw new Error(`no agent "${agentId}" in mesh "${name}"`);
    if (entry.status === "running" && entry.client) entry.client.newSession(agentId);
    else await clearAgentSession(this.runDir, name, agentId);
  }

  /** One-click: switch every agent in the mesh to a fresh session. */
  async newAllSessions(name: string): Promise<void> {
    const entry = this.require(name);
    if (entry.status === "running" && entry.client) entry.client.newAllSessions();
    else await clearAllAgentSessions(this.runDir, name);
  }
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/mesh-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mesh-manager.ts src/mesh-manager.test.ts
git commit -m "feat(mesh-manager): newAgentSession/newAllSessions (daemon or on-disk)"
```

---

### Task 7: gateway — delegate + refresh

**Files:**
- Modify: `src/web/gateway.ts`

- [ ] **Step 1: Add methods**

After `interruptAgent(...)` / `wakeAgent(...)` (around line 414):

```ts
  async newAgentSession(name: string, agentId: string): Promise<void> {
    await this.manager.newAgentSession(name, agentId);
    this.refreshMeshes();
  }
  async newAllSessions(name: string): Promise<void> {
    await this.manager.newAllSessions(name);
    this.refreshMeshes();
  }
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/gateway.ts
git commit -m "feat(gateway): newAgentSession/newAllSessions delegation"
```

---

### Task 8: api — HTTP routes

**Files:**
- Modify: `src/web/api.ts`
- Test: `src/web/api.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/web/api.test.ts` (model on existing per-agent route tests — they assert the gateway method is called for a given POST). Use the same fake-gateway / handler-invocation pattern already present in the file:

```ts
test("POST /api/meshes/:name/session triggers newAllSessions", async () => {
  const calls: string[] = [];
  const gw: any = { newAllSessions: async (n: string) => { calls.push(n); } };
  const res = await handle("POST", "/api/meshes/m/session", {}, gw);
  expect(res.status).toBe(200);
  expect(calls).toEqual(["m"]);
});

test("POST /api/meshes/:name/agents/:id/session triggers newAgentSession", async () => {
  const calls: Array<[string, string]> = [];
  const gw: any = { newAgentSession: async (n: string, a: string) => { calls.push([n, a]); } };
  const res = await handle("POST", "/api/meshes/m/agents/router/session", {}, gw);
  expect(res.status).toBe(200);
  expect(calls).toEqual([["m", "router"]]);
});
```

Match the existing test's exact invocation signature for `handle(...)` (helper name/args differ — read the top of `api.test.ts` and mirror its existing per-agent test, e.g. the `interrupt` route test, exactly).

- [ ] **Step 2: Run, verify it fails**

Run: `bun test src/web/api.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Implement**

In `src/web/api.ts`, inside the `POST && p.length === 3` block (after the `prompt` case, around line 134):

```ts
        if (p[2] === "session") {
          await gw.newAllSessions(name);
          return ok();
        }
```

Inside the `POST && p.length === 5 && p[2] === "agents"` block (after the `wake` case, around line 171):

```ts
        if (p[4] === "session") {
          await gw.newAgentSession(name, agentId);
          return ok();
        }
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/web/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/api.test.ts
git commit -m "feat(api): POST routes for per-agent and mesh-wide new session"
```

---

### Task 9: transcript — "new session" divider

**Files:**
- Modify: `src/web/types.ts`
- Modify: `src/web/transcript.ts`
- Test: `src/web/transcript.test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/web/transcript.test.ts`:

```ts
test("__session_reset__ folds into a divider item and seals open messages", () => {
  let r = reduceTranscript([], { sessionUpdate: "agent_message_chunk", content: { text: "hi" } }, "t0");
  r = reduceTranscript(r.items, { sessionUpdate: "__session_reset__" }, "t1");
  const divider = r.items.find((it) => it.kind === "divider");
  expect(divider).toBeTruthy();
  // any open streaming message was sealed
  const msg = r.items.find((it) => it.kind === "message");
  expect((msg as any).complete).toBe(true);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `bun test src/web/transcript.test.ts`
Expected: FAIL — no `divider` item produced.

- [ ] **Step 3: Add the type**

In `src/web/types.ts`, add to the `TranscriptItem` union (after the `mail` member on line 56):

```ts
  | { id: string; kind: "divider"; label: string; ts: string };
```

- [ ] **Step 4: Implement the reducer branch**

In `src/web/transcript.ts`, add before the final fallback `return { items: next, ops: [] };` (after the `__mail__` block):

```ts
  // Synthetic "context was reset" marker emitted by control-plane.newSession.
  if (k === "__session_reset__") {
    closeOpen();
    const id = nid(now);
    const item: TranscriptItem = { id, kind: "divider", label: String(update.label ?? "new session"), ts: now };
    next = [...next, item];
    ops.push({ op: "upsert", item });
    return { items: next, ops };
  }
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test src/web/transcript.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/types.ts src/web/transcript.ts src/web/transcript.test.ts
git commit -m "feat(transcript): __session_reset__ divider item"
```

---

### Task 10: client store — commands

**Files:**
- Modify: `src/web/client/store.ts`

- [ ] **Step 1: Add interface members**

In the `Store` interface (after `wakeAgent` on line 141):

```ts
  newAgentSession(name: string, agentId: string): Promise<any>;
  newAllSessions(name: string): Promise<any>;
```

- [ ] **Step 2: Add implementations**

In `createStore()` (after the `wakeAgent` impl on line 268):

```ts
    newAgentSession: (n, a) => guard(post(`/api/meshes/${enc(n)}/agents/${enc(a)}/session`), `new session ${a}`),
    newAllSessions: (n) => guard(post(`/api/meshes/${enc(n)}/session`), `new sessions ${n}`),
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/client/store.ts
git commit -m "feat(web-store): newAgentSession/newAllSessions commands"
```

---

### Task 11: client UI — divider render, buttons, i18n

**Files:**
- Modify: `src/web/client/i18n.ts`
- Modify: `src/web/client/Transcript.tsx`
- Modify: `src/web/client/MeshDetail.tsx`

- [ ] **Step 1: i18n keys**

In `src/web/client/i18n.ts`, add (near the `wake` keys):

```ts
  "new session": ["new session", "新会话"],
  "new session.confirm": ["reset?", "确认重置?"],
  "new session.hint": ["switch this agent to a fresh session (clears its context)", "把该 agent 切到新会话（清空上下文）"],
  "new sessions all": ["new sessions", "全部新会话"],
  "new sessions all.confirm": ["reset all?", "确认全部重置?"],
  "new sessions all.hint": ["switch every agent to a fresh session", "把所有 agent 切到新会话"],
  "session.reset.divider": ["new session", "新会话"],
```

- [ ] **Step 2: Render the divider**

In `src/web/client/Transcript.tsx`, add a branch before the final `PlanCard` fallback (line 200). Replace:

```tsx
        ) : it.kind === "mail" ? (
          <MailBubble key={it.id} item={it} meshId={author?.meshId} />
        ) : (
          <PlanCard key={it.id} item={it} />
        ),
```

with:

```tsx
        ) : it.kind === "mail" ? (
          <MailBubble key={it.id} item={it} meshId={author?.meshId} />
        ) : it.kind === "divider" ? (
          <Divider key={it.id} />
        ) : (
          <PlanCard key={it.id} item={it} />
        ),
```

Add the `Divider` component near the other small components in `Transcript.tsx` (it needs `useI18n` — already imported in this file if `t` is used; if not, import it):

```tsx
function Divider() {
  const { t } = useI18n();
  return (
    <div className="session-divider" role="separator">
      <span>{t("session.reset.divider")}</span>
    </div>
  );
}
```

If `useI18n` is not yet imported in `Transcript.tsx`, add `import { useI18n } from "./i18n";`.

- [ ] **Step 3: Add the divider CSS**

Append to the app stylesheet (the file that defines `.stream` / `.empty` — find it with `grep -rl "\.stream" src/web/client/*.css`; likely `src/web/client/app.css`):

```css
.session-divider {
  display: flex;
  align-items: center;
  text-align: center;
  gap: 8px;
  margin: 12px 0;
  color: var(--muted, #888);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.session-divider::before,
.session-divider::after {
  content: "";
  flex: 1;
  border-top: 1px solid var(--border, #444);
}
```

- [ ] **Step 4: Per-agent button**

In `src/web/client/MeshDetail.tsx`, in the `conv-control` row (after the `canWake` block, around line 289), add a confirm button shown only when the agent is part of a running mesh. Use the existing `ConfirmButton`:

```tsx
          {live ? (
            <ConfirmButton
              small
              kind="ghost"
              confirmLabel={t("new session.confirm")}
              title={t("new session.hint")}
              onConfirm={() => void store.newAgentSession(m.name, cur.id)}
            >
              {t("new session")}
            </ConfirmButton>
          ) : null}
```

Note: `ConfirmButton` is already imported in `MeshDetail.tsx` (line 7). `live` and `cur`/`m`/`store`/`t` are already in scope in this component.

- [ ] **Step 5: Mesh-wide button**

In the `Header` component of `MeshDetail.tsx`, inside the `live ?` branch (next to `stop mesh`, around line 26-29), add the mesh-wide reset:

```tsx
      {live ? (
        <>
          <ConfirmButton
            kind="ghost"
            confirmLabel={t("new sessions all.confirm")}
            title={t("new sessions all.hint")}
            onConfirm={() => void store.newAllSessions(m.name)}
          >
            {t("new sessions all")}
          </ConfirmButton>
          <Btn kind="stop" onClick={() => void store.stopMesh(m.name)}>
            {t("stop mesh")}
          </Btn>
        </>
      ) : (
```

(Keep the existing `else` branch unchanged. `ConfirmButton` and `Btn` are both imported.)

- [ ] **Step 6: Typecheck + build the client**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/client/i18n.ts src/web/client/Transcript.tsx src/web/client/MeshDetail.tsx src/web/client/*.css
git commit -m "feat(web-ui): new-session buttons (per-agent + mesh) and transcript divider"
```

---

### Task 12: e2e — button → confirm → divider

**Files:**
- Create: `src/web/new-session.e2e.ts`

- [ ] **Step 1: Write the e2e**

Model it on `src/web/session-resume.e2e.ts` (same harness: a fake mesh-host via `MESH_HOST_SCRIPT`, Playwright with bundled chromium). The flow: start backend with a fake host, define+start a mesh, open the console, select the router, click the per-agent "new session" button twice (arm + confirm), and assert a `.session-divider` appears in that agent's transcript. Read `session-resume.e2e.ts` first and reuse its exact setup/teardown helpers; only the interaction + assertion differ:

```ts
// after selecting the router agent and confirming the mesh is running:
const reset = page.getByRole("button", { name: /new session/i }).first();
await reset.click();            // arms
await reset.click();            // confirms
await expect(page.locator(".session-divider")).toBeVisible();
```

If the fake host in that e2e doesn't implement `newSession`, extend it minimally to emit a `{ kind: "update", agent, update: { sessionUpdate: "__session_reset__" } }` event on the `newSession` frame (mirror how it handles `interrupt`).

- [ ] **Step 2: Run**

Run: `bun test src/web/new-session.e2e.ts`
Expected: PASS. If it flakes on timing, add an explicit `await expect(reset).toBeVisible()` before clicking.

- [ ] **Step 3: Commit**

```bash
git add src/web/new-session.e2e.ts src/web/fake.ts
git commit -m "test(web): e2e for new-session button + transcript divider"
```

---

### Task 13: full verification gate

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Full unit suite**

Run: `bun test`
Expected: all green (existing + new).

- [ ] **Step 3: e2e suite (the relevant ones)**

Run: `bun test src/web/new-session.e2e.ts src/web/session-resume.e2e.ts`
Expected: PASS — confirm no regression in the resume e2e.

- [ ] **Step 4: Manual browser smoke (temporary dev instance)**

```bash
bun run src/main.ts --port 10020 --root ~/.agent-mesh-dev
```
Open `http://127.0.0.1:10020`, start a mesh, click per-agent "new session" (arm+confirm) → divider appears; click mesh "new sessions" → divider in each agent. Kill the dev instance afterward. NEVER touch port 10010 / `~/.agent-mesh`.

- [ ] **Step 5: Final commit (if any docs/cleanup remain)**

```bash
git add -A && git commit -m "chore(new-session): docs + cleanup" || true
```

---

## Self-Review notes

- **Spec coverage:** single-agent (Task 3/6/8/11), mesh-wide (Task 3/6/8/11), running vs not-running agent (Task 3), stopped-mesh on-disk path (Task 6), transcript divider = design §3 (Task 9/11), confirmation = design §4 (Task 11 via ConfirmButton), plumbing chain = design §5 (Tasks 2,4,5,7,8). All covered.
- **Type consistency:** `newSession`/`newAllSessions` (control-plane, host, host-client), `newAgentSession`/`newAllSessions` (manager, gateway, store), `clearAgentSession`/`clearAllAgentSessions` (session-storage), `__session_reset__` + `divider`/`label` (transcript+types) used consistently across tasks.
- **Invariant:** not-running agents are never spawned by `newSession` (Task 3 live-gate); `clear*` never sets `meshExpectedAlive` true (Task 1) so a stopped/killed agent is not resurrected.
