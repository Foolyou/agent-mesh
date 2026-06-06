# Mesh WebUI (React + Bun) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the terminal TUI with a React + Bun WebUI that is a maximal control console over the existing `MeshManager` + optional `MasterAgent`, covering all documented UI functionality and the 6 PoC points, with aggregated transcript rendering.

**Architecture:** In-process Bun web server (`Bun.serve`, native bundler — no Vite). A testable `WebGateway` wraps `MeshManager`/`MasterAgent`, holds authoritative state (aggregated transcripts + bounded event lists), serves a snapshot on connect and deltas thereafter over one WebSocket; commands go over REST. The subprocess-per-mesh model is unchanged.

**Tech Stack:** Bun 1.3, TypeScript, React 18 + react-dom (only added runtime deps), plain CSS (terminal theme), Bun test runner, Playwright (MCP) for browser verification.

**Spec:** `docs/superpowers/specs/2026-06-07-mesh-webui-design.md`

---

## File structure

Backend (`src/web/`):
- `types.ts` — shared wire/state types: `TranscriptItem`, `TranscriptOp`, `ConvRef`, `MeshSummary`, `ActivityEntry`, `PermissionReq`, `ResolvedPermission`, `MailEntry`, `GatewayState`, `ServerMsg`.
- `transcript.ts` — pure `reduceTranscript(items, update, now)` aggregation reducer.
- `gateway.ts` — `WebGateway`: subscribes to manager/master, folds streams into `GatewayState`, exposes command methods + `subscribe()`.
- `api.ts` — pure `handleApi(gateway, method, path, body)` → `{ status, body }` REST router.
- `server.ts` — `startWebServer(gateway, opts)`: `Bun.serve` wiring (HTML/bundler routes, API routes → `handleApi`, `/ws` upgrade → `gateway.subscribe`).

Frontend (`src/web/client/`):
- `index.html`, `index.tsx` — entry; mounts `<App/>`.
- `store.ts` — `createStore()` over `ServerMsg` (pure `applyMsg(state, msg)` reducer) + WS connection + REST command helpers; `useStore` via `useSyncExternalStore`.
- `App.tsx`, `AppShell.tsx`.
- `Sidebar.tsx` (`MeshList`, `MasterChat`, `NewMeshButton` → `MeshBuilderModal`).
- `MeshDetail.tsx` (`MeshHeader`, `TopologyGraph`, `RouterChat`, `AgentPanels`, `PermissionPrompts`, `ActivityTimeline`, `MailboxTimeline`, `PermissionHistory`).
- `Transcript.tsx` — renders `TranscriptItem[]` (message / thought / tool_call).
- `useKeyboard.ts` — TUI keybinding parity.
- `theme.css` — black/white terminal theme.

Root:
- `main.ts` — swap TUI bootstrap for web server.
- `package.json`, `tsconfig.json` — deps + JSX.
- Remove: `src/tui/app.ts`, `src/tui/line-editor.ts`, `src/tui/line-editor.test.ts`.

> **Execution note:** Backend testable units (`transcript`, `gateway`, `api`, `store`) are built strictly TDD with full code below. React presentation components are specified by contract (file, responsibility, props, key logic) and verified in the browser (Playwright) in Phase 9, not unit-TDD'd line-by-line — this is the appropriate test altitude for UI and is the executor's standing decision.

---

## Phase 0: Scaffolding

### Task 0: Deps, tsconfig, dirs

**Files:** Modify `package.json`, `tsconfig.json`; create `src/web/` dirs.

- [ ] **Step 1:** Add React deps.
```bash
bun add react react-dom
bun add -d @types/react @types/react-dom
```
- [ ] **Step 2:** Ensure `tsconfig.json` has `"jsx": "react-jsx"`, `"lib": ["ESNext","DOM","DOM.Iterable"]`, `"types": ["bun"]`. Edit as needed.
- [ ] **Step 3:** Add scripts to `package.json`: keep `"mesh": "bun run src/main.ts"`; add `"web": "bun run src/main.ts"` alias. (No separate build step — Bun bundles on serve.)
- [ ] **Step 4:** `git add -A && git commit -m "chore: add react deps + jsx tsconfig for webui"`

---

## Phase 1: Transcript aggregation reducer (TDD)

### Task 1: `reduceTranscript`

**Files:** Create `src/web/types.ts` (transcript types only for now), `src/web/transcript.ts`, `src/web/transcript.test.ts`.

- [ ] **Step 1: Write failing tests** — `src/web/transcript.test.ts`:
```ts
import { test, expect } from "bun:test";
import { reduceTranscript } from "./transcript";
import type { TranscriptItem } from "./types";

const T = "2026-06-07T00:00:00.000Z";
function fold(updates: any[]): TranscriptItem[] {
  let items: TranscriptItem[] = [];
  for (const u of updates) items = reduceTranscript(items, u, T).items;
  return items;
}

test("coalesces consecutive agent_message_chunk into one message", () => {
  const items = fold([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "message", role: "agent", text: "Hello", complete: false });
});

test("thought chunks coalesce into a thought item", () => {
  const items = fold([
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should " } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan" } },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "thought", text: "I should plan" });
});

test("tool_call then tool_call_update merge into one card updated in place", () => {
  const items = fold([
    { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read file", kind: "read", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }] },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "tc1", title: "Read file", status: "completed" });
  expect((items[0] as any).output).toContain("ok");
});

test("a tool_call closes an open message; later text opens a new message", () => {
  const items = fold([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "thinking" } },
    { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Run", status: "pending" },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
  ]);
  expect(items.map((i) => i.kind)).toEqual(["message", "tool_call", "message"]);
  expect(items[0]).toMatchObject({ complete: true });
});

test("tool_call_update before tool_call upserts the card", () => {
  const items = fold([
    { sessionUpdate: "tool_call_update", toolCallId: "tcX", status: "completed", title: "Late" },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "tool_call", toolCallId: "tcX", status: "completed" });
});

test("user echo update appends a completed user message", () => {
  const items = fold([
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi router" } },
  ]);
  expect(items[0]).toMatchObject({ kind: "message", role: "user", text: "hi router", complete: true });
});

test("ops report upsert for new item and patch for appended text", () => {
  const first = reduceTranscript([], { sessionUpdate: "agent_message_chunk", content: { text: "a" } }, T);
  expect(first.ops[0].op).toBe("upsert");
  const second = reduceTranscript(first.items, { sessionUpdate: "agent_message_chunk", content: { text: "b" } }, T);
  expect(second.ops[0]).toMatchObject({ op: "patch" });
});

test("unknown update kinds are ignored (no items, no ops)", () => {
  const r = reduceTranscript([], { sessionUpdate: "available_commands_update", availableCommands: [] }, T);
  expect(r.items).toHaveLength(0);
  expect(r.ops).toHaveLength(0);
});
```
- [ ] **Step 2: Run, expect fail** — `bun test src/web/transcript.test.ts` → FAIL (module/exports missing).
- [ ] **Step 3: Define types** in `src/web/types.ts`:
```ts
export type TranscriptItem =
  | { id: string; kind: "message"; role: "user" | "agent"; text: string; ts: string; complete: boolean }
  | { id: string; kind: "thought"; text: string; ts: string; complete: boolean }
  | { id: string; kind: "tool_call"; toolCallId: string; title: string; toolKind?: string;
      status: "pending" | "in_progress" | "completed" | "failed"; output?: string; ts: string; updatedTs: string };

export type TranscriptOp =
  | { op: "upsert"; item: TranscriptItem }
  | { op: "patch"; id: string; patch: Partial<TranscriptItem> };
```
- [ ] **Step 4: Implement** `src/web/transcript.ts`:
```ts
import type { TranscriptItem, TranscriptOp } from "./types";

let seq = 0;
function nid(now: string): string { return `i${now}-${seq++}`; }

function textOf(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (content.content) return textOf(content.content);
  return "";
}
function outputOf(content: any, rawOutput: any): string {
  let s = "";
  if (Array.isArray(content)) s = content.map((c: any) => textOf(c.content ?? c)).join("");
  if (!s && rawOutput) { try { s = JSON.stringify(rawOutput); } catch { s = String(rawOutput); } }
  return s;
}

export function reduceTranscript(
  items: TranscriptItem[],
  update: any,
  now: string,
): { items: TranscriptItem[]; ops: TranscriptOp[] } {
  const k = update?.sessionUpdate;
  const ops: TranscriptOp[] = [];
  let next = items;

  const closeOpen = () => {
    next = next.map((it) =>
      (it.kind === "message" || it.kind === "thought") && !it.complete
        ? (ops.push({ op: "patch", id: it.id, patch: { complete: true } }), { ...it, complete: true })
        : it,
    );
  };
  const last = () => next[next.length - 1];

  if (k === "agent_message_chunk" || k === "agent_thought_chunk" || k === "user_message_chunk") {
    const text = textOf(update.content);
    const role: "user" | "agent" = k === "user_message_chunk" ? "user" : "agent";
    const wantKind = k === "agent_thought_chunk" ? "thought" : "message";
    const open = last();
    const sameOpen =
      open && !open.complete &&
      ((wantKind === "thought" && open.kind === "thought") ||
       (wantKind === "message" && open.kind === "message" && open.role === role));
    if (sameOpen) {
      const merged = { ...(open as any), text: (open as any).text + text };
      next = [...next.slice(0, -1), merged];
      ops.push({ op: "patch", id: open.id, patch: { text: merged.text } });
    } else {
      const id = nid(now);
      const item: TranscriptItem =
        wantKind === "thought"
          ? { id, kind: "thought", text, ts: now, complete: role === "user" }
          : { id, kind: "message", role, text, ts: now, complete: role === "user" };
      next = [...next, item];
      ops.push({ op: "upsert", item });
    }
    return { items: next, ops };
  }

  if (k === "tool_call") {
    closeOpen();
    const id = nid(now);
    const item: TranscriptItem = {
      id, kind: "tool_call", toolCallId: String(update.toolCallId), title: update.title ?? "tool",
      toolKind: update.kind, status: update.status ?? "pending",
      output: outputOf(update.content, update.rawOutput) || undefined, ts: now, updatedTs: now,
    };
    next = [...next, item];
    ops.push({ op: "upsert", item });
    return { items: next, ops };
  }

  if (k === "tool_call_update") {
    const tcid = String(update.toolCallId);
    const idx = next.findIndex((it) => it.kind === "tool_call" && it.toolCallId === tcid);
    const patch: any = { updatedTs: now };
    if (update.status != null) patch.status = update.status;
    if (update.title != null) patch.title = update.title;
    if (update.kind != null) patch.toolKind = update.kind;
    const out = outputOf(update.content, update.rawOutput);
    if (out) patch.output = ((idx >= 0 ? (next[idx] as any).output : "") || "") + out;
    if (idx >= 0) {
      const merged = { ...(next[idx] as any), ...patch };
      next = [...next.slice(0, idx), merged, ...next.slice(idx + 1)];
      ops.push({ op: "patch", id: next[idx].id, patch });
    } else {
      const id = nid(now);
      const item: TranscriptItem = {
        id, kind: "tool_call", toolCallId: tcid, title: update.title ?? "tool",
        toolKind: update.kind, status: update.status ?? "pending",
        output: out || undefined, ts: now, updatedTs: now,
      };
      next = [...next, item];
      ops.push({ op: "upsert", item });
    }
    return { items: next, ops };
  }

  // Turn boundary sentinel (caller may pass { sessionUpdate: "__turn_end__" }).
  if (k === "__turn_end__") { closeOpen(); return { items: next, ops }; }

  return { items: next, ops: [] };
}
```
- [ ] **Step 5: Run, expect pass** — `bun test src/web/transcript.test.ts` → PASS (8 tests).
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(web): aggregated transcript reducer (TDD)"`

---

## Phase 2: Shared state types

### Task 2: Extend `src/web/types.ts`

**Files:** Modify `src/web/types.ts`.

- [ ] **Step 1:** Append the wire/state types (no test — pure types):
```ts
import type { MeshConfig, MeshEvent, AgentId, AgentStatus, AgentRole, HarnessId } from "../acp/types";
export type MeshStatus = "stopped" | "starting" | "running" | "dead";

export type ConvRef = { scope: "master" } | { scope: "agent"; mesh: string; agent: AgentId };

export interface MeshSummary {
  name: string; defined: boolean; status: MeshStatus; router: AgentId;
  agents: { id: AgentId; harness: HarnessId; role: AgentRole; status: AgentStatus }[];
}
export interface ActivityEntry { id: string; ts: string; kind: "mail" | "interrupt" | "permission_resolved" | "log"; text: string; }
export interface PermissionReq { requestId: string; agent: AgentId; question: string; options: { id: string; name: string; kind?: string }[]; ts: string; }
export interface ResolvedPermission { requestId: string; agent: AgentId; optionId: string; by: "human" | "timeout"; ts: string; }
export interface MailEntry { id: string; ts: string; from: AgentId; to: AgentId; body: string; }

export interface PerMeshState {
  config: MeshConfig;
  transcripts: Record<AgentId, TranscriptItem[]>;
  activity: ActivityEntry[]; mail: MailEntry[]; pending: PermissionReq[]; history: ResolvedPermission[];
}
export interface GatewayState {
  meshes: MeshSummary[];
  master: { status: "absent" | "starting" | "ready" | "stopped"; transcript: TranscriptItem[] };
  perMesh: Record<string, PerMeshState>;
}

export type ServerMsg =
  | { t: "snapshot"; state: GatewayState }
  | { t: "mesh.list"; meshes: MeshSummary[] }
  | { t: "mesh.status"; name: string; status: MeshStatus }
  | { t: "agent.status"; name: string; agent: AgentId; status: AgentStatus; detail?: string }
  | { t: "transcript.upsert"; conv: ConvRef; item: TranscriptItem }
  | { t: "transcript.patch"; conv: ConvRef; id: string; patch: Partial<TranscriptItem> }
  | { t: "activity"; name: string; entry: ActivityEntry }
  | { t: "mail"; name: string; entry: MailEntry }
  | { t: "permission.add"; name: string; req: PermissionReq }
  | { t: "permission.remove"; name: string; resolved: ResolvedPermission }
  | { t: "master.status"; status: "absent" | "starting" | "ready" | "stopped" };
export type { MeshConfig, MeshEvent, AgentId, AgentStatus };
```
- [ ] **Step 2:** `bun build src/web/types.ts --target=bun >/dev/null` (typecheck-compile sanity) or `bunx tsc --noEmit`. Expect no errors.
- [ ] **Step 3:** Commit — `git add -A && git commit -m "feat(web): shared gateway/wire types"`

---

## Phase 3: WebGateway (TDD)

### Task 3: `WebGateway`

The gateway needs a minimal manager interface so tests use a fake. Define `ManagerLike` structurally.

**Files:** Create `src/web/gateway.ts`, `src/web/gateway.test.ts`.

- [ ] **Step 1: Failing tests** — `src/web/gateway.test.ts`:
```ts
import { test, expect } from "bun:test";
import { WebGateway } from "./gateway";
import type { MeshEvent, MeshConfig } from "../acp/types";

const CFG: MeshConfig = {
  name: "demo",
  agents: [
    { id: "router", harness: "claude", project: "p", role: "router" },
    { id: "codex-1", harness: "codex", project: "p", role: "member" },
  ],
  edges: [["router", "codex-1"]],
};

function fakeManager() {
  let listener: ((n: string, e: MeshEvent) => void) | null = null;
  const calls: any[] = [];
  return {
    calls,
    emit(n: string, e: MeshEvent) { listener?.(n, e); },
    on(l: any) { listener = l; return () => { listener = null; }; },
    listMeshes() { return [{ name: "demo", defined: true, status: "running" as const }]; },
    configOf() { return CFG; },
    routerOf() { return "router"; },
    async startMesh(n: string) { calls.push(["start", n]); },
    async stopMesh(n: string) { calls.push(["stop", n]); },
    async promptRouter(n: string, t: string) { calls.push(["promptRouter", n, t]); },
    promptAgent(n: string, a: string, t: string) { calls.push(["promptAgent", n, a, t]); },
    resolvePermission(n: string, r: string, o: string) { calls.push(["resolve", n, r, o]); },
    setMode(n: string, a: string, m: string) { calls.push(["setMode", n, a, m]); },
    async defineMesh(c: MeshConfig) { calls.push(["define", c.name]); },
    async loadDefinitions() { calls.push(["reload"]); },
    async stopAll() {},
  };
}

test("snapshot includes meshes with composed agent rows", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const s = gw.snapshot();
  expect(s.meshes[0]).toMatchObject({ name: "demo", status: "running", router: "router" });
  expect(s.meshes[0].agents.map((a) => a.id)).toEqual(["router", "codex-1"]);
});

test("update event folds into the agent transcript and broadcasts a transcript op", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg)); // first msg is snapshot
  m.emit("demo", { kind: "update", agent: "router",
    update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } } as any, ts: "T" });
  const up = got.find((x) => x.t === "transcript.upsert");
  expect(up.conv).toMatchObject({ scope: "agent", mesh: "demo", agent: "router" });
  expect(up.item).toMatchObject({ kind: "message", text: "hi" });
  expect(gw.snapshot().perMesh.demo.transcripts.router[0].text).toBe("hi");
});

test("permission add then resolved updates pending + history + activity", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  const got: any[] = [];
  gw.subscribe((msg) => got.push(msg));
  m.emit("demo", { kind: "permission", agent: "codex-1", requestId: "r1", question: "run?",
    options: [{ id: "allow", name: "Allow" }], ts: "T" });
  expect(gw.snapshot().perMesh.demo.pending).toHaveLength(1);
  expect(got.some((x) => x.t === "permission.add")).toBe(true);
  m.emit("demo", { kind: "permission_resolved", agent: "codex-1", requestId: "r1", optionId: "allow", by: "human", ts: "T" });
  const s = gw.snapshot();
  expect(s.perMesh.demo.pending).toHaveLength(0);
  expect(s.perMesh.demo.history).toHaveLength(1);
  expect(s.perMesh.demo.activity.some((a) => a.kind === "permission_resolved")).toBe(true);
});

test("mail event emits both activity and mail entries", () => {
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
});

test("command methods delegate to the manager", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  await gw.startMesh("demo");
  await gw.promptRouter("demo", "go");
  gw.resolvePermission("demo", "r1", "allow");
  expect(m.calls).toContainEqual(["start", "demo"]);
  expect(m.calls).toContainEqual(["promptRouter", "demo", "go"]);
  expect(m.calls).toContainEqual(["resolve", "demo", "r1", "allow"]);
});

test("promptRouter echoes a user message into the router transcript", async () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  await gw.promptRouter("demo", "hello");
  const tr = gw.snapshot().perMesh.demo.transcripts.router;
  expect(tr[tr.length - 1]).toMatchObject({ kind: "message", role: "user", text: "hello" });
});

test("agent_status updates the mesh summary agent row", () => {
  const m = fakeManager();
  const gw = new WebGateway(m as any);
  m.emit("demo", { kind: "agent_status", agent: "codex-1", status: "ready", ts: "T" });
  const row = gw.snapshot().meshes[0].agents.find((a) => a.id === "codex-1");
  expect(row?.status).toBe("ready");
});
```
- [ ] **Step 2: Run, expect fail** — `bun test src/web/gateway.test.ts`.
- [ ] **Step 3: Implement** `src/web/gateway.ts` — structural `ManagerLike` + `MasterLike`, folds events using `reduceTranscript`, maintains `GatewayState`, `subscribe()` pushes snapshot then deltas. Key points:
  - `ensureMesh(name)` lazily seeds `perMesh[name]` from `configOf`/`routerOf`.
  - `update` → pick `ConvRef {scope:"agent",mesh,agent}`, run reducer, store items, broadcast each op as `transcript.upsert/patch`.
  - `permission` → push `pending`, broadcast `permission.add`.
  - `permission_resolved` → remove pending, push `history` + `activity`, broadcast `permission.remove` + `activity`.
  - `mail` → push `mail` + `activity`, broadcast both.
  - `interrupt`/`log` → push `activity`, broadcast `activity`.
  - `agent_status` → update summary row + broadcast `agent.status` and recompute `mesh.list`.
  - master `onUpdate` → reducer into `master.transcript`, broadcast with `conv {scope:"master"}`.
  - command methods: `startMesh/stopMesh/reload/defineMesh` delegate; `promptRouter/promptAgent/promptMaster` echo a `user_message_chunk` into the proper transcript then delegate; `resolvePermission/setMode` delegate.
  - ring-buffer caps: activity/mail/history ≤ 500; transcripts ≤ 1000 (drop oldest).
  - `snapshot()` returns deep-ish copy of `GatewayState`; `mesh.list` recomputed from `listMeshes()` merged with tracked agent statuses + config.
- [ ] **Step 4: Run, expect pass** — `bun test src/web/gateway.test.ts` (7 tests).
- [ ] **Step 5: Commit** — `git commit -am "feat(web): WebGateway authoritative state + fan-out (TDD)"`

---

## Phase 4: REST API router (TDD)

### Task 4: `handleApi`

**Files:** Create `src/web/api.ts`, `src/web/api.test.ts`.

- [ ] **Step 1: Failing tests** — cover: `GET /api/state` → snapshot; `POST /api/meshes/demo/start` → calls start, 200; `POST /api/meshes/demo/prompt` `{text}` → promptRouter; `POST /api/meshes/demo/agents/codex-1/prompt`; `POST /api/meshes/demo/permissions/r1/resolve` `{optionId}`; `POST /api/meshes` invalid config → 400 with error; unknown path → 404; `POST /api/master/prompt` when master absent → 409. Use the `fakeManager` + a real `WebGateway`.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** `handleApi(gw, method, path, body): Promise<{status:number; body:any}>` — a small matcher over `path.split("/")`. Validate `POST /api/meshes` with `validateMeshConfig` (import from `../mesh-validate`); map thrown errors → `{status:400, body:{error:{message}}}`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(web): REST api router (TDD)"`

---

## Phase 5: HTTP/WS server

### Task 5: `startWebServer`

**Files:** Create `src/web/server.ts`, `src/web/client/index.html`, `src/web/client/index.tsx` (placeholder mount).

- [ ] **Step 1:** `index.html` references `index.tsx`; `index.tsx` renders a placeholder `<div>mesh webui</div>` (real app comes in Phase 8) so the bundler has an entry.
- [ ] **Step 2:** Implement `startWebServer(gateway, { port }) : { server, stop }`:
```ts
import index from "./client/index.html";
export function startWebServer(gw, { port = 7317 } = {}) {
  const server = Bun.serve({
    port, development: { hmr: true },
    routes: {
      "/": index,
      "/api/*": async (req) => {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.json().catch(() => ({})) : undefined;
        const r = await handleApi(gw, req.method, url.pathname, body);
        return Response.json(r.body, { status: r.status });
      },
    },
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return; // handled
        return new Response("ws upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { const unsub = gw.subscribe((m) => ws.send(JSON.stringify(m))); (ws as any).data = { unsub }; },
      message() {},
      close(ws) { (ws as any).data?.unsub?.(); },
    },
  });
  return { server, stop: () => server.stop(true) };
}
```
  (Note: confirm Bun 1.3 route-pattern `"/api/*"`; if not supported, route via `fetch` instead. Verify empirically in Step 3.)
- [ ] **Step 3: Integration smoke** — `src/web/server.smoke.ts`: start server with a `WebGateway(fakeManager)` on an ephemeral port, `fetch("/api/state")` → 200 snapshot, open a WS and assert first frame is `{t:"snapshot"}`, hit `/` → 200 HTML. Run `bun run src/web/server.smoke.ts`; expect "OK".
- [ ] **Step 4: Commit** — `git commit -am "feat(web): Bun http+ws server (bundler, api, ws fan-out)"`

---

## Phase 6: Bootstrap swap + remove TUI

### Task 6: `main.ts` + cleanup

**Files:** Modify `src/main.ts`, `package.json`; delete `src/tui/*`.

- [ ] **Step 1:** Rewrite `main.ts`: build `MeshManager`, seed `DEMO_MESH`, `loadDefinitions()`, optional `MasterAgent` (wire `onUpdate` → gateway), `new WebGateway(manager, master)`, `startWebServer(gw, {port})`, print `http://localhost:<port>`; `SIGINT`/`exit` → `stop()` + `manager.stopAll()` + `master?.stop()`.
- [ ] **Step 2:** Delete `src/tui/app.ts`, `src/tui/line-editor.ts`, `src/tui/line-editor.test.ts`. `rmdir src/tui` if empty.
- [ ] **Step 3:** `bun test` (whole suite) → green (TUI tests gone, web tests pass). `bunx tsc --noEmit` clean.
- [ ] **Step 4:** Launch sanity: `bun run src/main.ts &` then `curl -s localhost:7317/api/state | head -c 200`; kill. Expect JSON snapshot.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): launch web server from main.ts; remove TUI"`

---

## Phase 7: Frontend store (TDD)

### Task 7: `applyMsg` reducer + store

**Files:** Create `src/web/client/store.ts`, `src/web/client/store.test.ts`.

- [ ] **Step 1: Failing tests** for pure `applyMsg(state, msg)`: snapshot replaces state; `transcript.upsert` appends to the right conv (master vs agent); `transcript.patch` mutates the item (text append, status change); `mesh.status` updates summary; `permission.add`/`permission.remove` adjust pending/history; `activity`/`mail` prepend/append to lists; `agent.status` updates row. Also an `emptyState()`.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** `applyMsg` (pure, mirrors gateway folding on the client) + `createStore()` (holds state, `getSnapshot`, `subscribe`, `dispatch(msg)`, WS connect w/ backoff, REST command helpers: `startMesh`, `stopMesh`, `reload`, `promptRouter`, `promptAgent`, `promptMaster`, `resolvePermission`, `setMode`, `defineMesh`) + `useStore(selector)` via `useSyncExternalStore`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(web): client store + applyMsg reducer (TDD)"`

---

## Phase 8: React components (contract-driven; browser-verified)

### Task 8: Build the UI

**Files:** Create the components listed in File Structure + `theme.css`. Implement against `store` selectors and command helpers.

Contracts (implement each; verify in Phase 9):
- [ ] **AppShell** — top bar: title, `master.status` dot, ws-connected dot, `[+ new mesh]`, `[reload]`. Grid: `Sidebar` left, `MeshDetail` right (selected mesh from local state; `Esc` clears).
- [ ] **MeshList** — rows: `▸` selection, name, `●/○` colored by status, `[start]`/`[stop]` button per status. Click selects; `Tab` cycles.
- [ ] **MasterChat** — `<Transcript items={master.transcript}/>` + input → `promptMaster`. Greyed + disabled when `master.status==="absent"`.
- [ ] **MeshBuilderModal** — form (name; repeatable agent rows id/harness/role/project; edges from→to selects). Client validation mirroring `mesh-validate`; submit → `defineMesh`; show server error inline.
- [ ] **MeshHeader** — name, `router=`, status, `[stop]`/`[start]`.
- [ ] **TopologyGraph** — SVG; deterministic radial layout (router center, members on a ring); nodes colored by `agent.status`; arrows for `config.edges`; click node → select agent panel; brief flash on interrupt (subscribe to a transient highlight via activity).
- [ ] **RouterChat** — `<Transcript>` of router agent transcript; input → `promptRouter`; `Ctrl-F` fullscreen.
- [ ] **AgentPanels** — tab per member; `<Transcript>` of that agent; input → `promptAgent`; `mode ▾` → `setMode`.
- [ ] **PermissionPrompts** — cards: `⚠ [mesh] agent: question`, option buttons `1) … 2) …`; click or digit → `resolvePermission`.
- [ ] **ActivityTimeline** / **MailboxTimeline** / **PermissionHistory** — timestamped lists from `perMesh[sel]`.
- [ ] **Transcript** — render `TranscriptItem[]`: message (user/agent), thought (collapsible, default collapsed), tool_call card (title, kind, status badge, collapsible output; caret on open message).
- [ ] **useKeyboard** — `1–9` resolve focused/first pending; `Tab` cycle mesh; `Ctrl-R` reload; `Esc` deselect; `Ctrl-F` fullscreen.
- [ ] **theme.css** — black bg, gray/white text, monospace; status accent vars `--ok`(green) `--warn`(amber) `--bad`(red) `--off`(gray).
- [ ] **Step Commit** — `git commit -am "feat(web): react control console UI"`

---

## Phase 9: Browser verification (Playwright MCP)

### Task 9: Verify every feature in a real browser

Run `bun run src/main.ts` (master optional; can disable master to isolate UI). Use Playwright MCP against `http://localhost:7317`. For deterministic UI tests without real agents, add a `--fake` mode to `main.ts` that constructs the gateway over an in-memory fake manager that emits scripted events (update chunks, tool_call+update, permission, mail, interrupt, agent_status), so every widget can be exercised offline.

- [ ] Snapshot/connect: load page → mesh list renders, ws dot connected.
- [ ] MeshList: start/stop buttons call API (status flips); Tab cycles selection.
- [ ] MasterChat: type + send → user bubble appears (or greyed if absent).
- [ ] MeshBuilder: open form, build a valid mesh → appears in list; invalid → inline error.
- [ ] RouterChat: send prompt → user bubble; scripted agent chunks coalesce into one growing bubble (NOT one-line-per-chunk).
- [ ] Tool call: scripted `tool_call`+updates → single card transitions pending→completed with output.
- [ ] Thought: collapsible, collapsed by default, expands on click.
- [ ] AgentPanels: tab switch; member prompt; mode change.
- [ ] Permission: card shows; digit `1` and button both resolve; lands in history.
- [ ] Topology: nodes + edges render; status colors; node click selects agent; interrupt flash.
- [ ] Activity/Mailbox/History timelines populate from scripted mail/interrupt/log/perm.
- [ ] Keyboard: Tab/Ctrl-R/Esc/Ctrl-F all behave.
- [ ] Take screenshots of key states; fix any defects found, re-verify.
- [ ] **Commit** — `git commit -am "test(web): browser-verified all features (+ fake event mode)"`

---

## Phase 10: Real-agent end-to-end

### Task 10: Fictional project mesh

- [ ] **Step 1:** Create a fictional project dir (e.g. `test_mesh_web/`) with a tiny brief (README describing a small feature to build).
- [ ] **Step 2:** Via the WebUI MeshBuilder (or master chat), define a mesh: router=`claude`, members `codex-1`=codex, `opencode-1`=opencode, all `project: test_mesh_web`, edges router→members and members↔.
- [ ] **Step 3:** Start the mesh in the browser; watch topology nodes go spawning→ready.
- [ ] **Step 4:** Prompt the router to coordinate the members on the fictional task; observe live: aggregated router/member transcripts, a real `send_mail` between members in the mailbox/activity, at least one permission escalation resolved from the UI, and (if triggered) an interrupt.
- [ ] **Step 5:** Stop the mesh from the UI; confirm subprocesses reaped (`pgrep` shows none). Screenshot the live console.
- [ ] **Step 6:** Document the run; **Commit** — `git commit -am "test(web): real opencode/codex/claude mesh e2e on a fictional project"`

---

## Phase 11: Docs + finish

### Task 11: README + wrap-up

- [ ] **Step 1:** Update `README.md`: architecture diagram `Human ⇄ WebUI`, Run section (browser URL + controls), remove TUI keybinding prose (or map to web), keep PTY note. Mark PoC point 6 as "the WebUI renders 1–5 live."
- [ ] **Step 2:** `bun test` full suite green; `bunx tsc --noEmit` clean.
- [ ] **Step 3:** Self-review diff; **Commit**; use `superpowers:finishing-a-development-branch` to integrate.

---

## Self-review notes
- Spec coverage: transcript aggregation (Task 1, 7, 8-Transcript, 9), gateway state + snapshot/deltas (Task 3), REST (Task 4), WS (Task 5), bootstrap + TUI removal (Task 6), all UI panels + topology + builder + permissions + timelines + keyboard (Task 8), 6 PoC points (Task 9 widgets + Task 10 live), error handling (gateway/api + browser checks), tests (Tasks 1/3/4/7 TDD; 9/10 browser+real). All spec sections map to a task.
- Types are defined once in `src/web/types.ts` and reused by gateway/api/server/store, keeping signatures consistent.
