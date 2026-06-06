# Mesh WebUI (React + Bun) — replace the TUI — Design

Date: 2026-06-07
Status: Approved (brainstorming) — pending implementation plan

## Goal

Replace the terminal TUI with a **React + Bun WebUI** that covers the full
functionality described in the docs — both the interactive multi-mesh TUI and the
richer "three-pane / per-agent" intent from the original PoC design — and renders
all 6 PoC verification points live. The WebUI is a **maximal control console**:
master-agent chat, full mesh lifecycle (create / start / stop / list / reload),
per-mesh topology, router chat, per-agent panels, permission decisions, mailbox and
activity timelines, and permission history.

Hard constraint: **the process model does not change.** Each running mesh stays in
its own `mesh-host` subprocess; the parent still owns `MeshManager` + optional
`MasterAgent` and reaps the whole subprocess tree on exit. The web server is simply
the new face of that same parent process.

## Decisions (resolved during brainstorming)

- **Scope:** maximal console (TUI parity + web enhancements: simultaneous multi-mesh
  view, per-agent live status, topology graph, per-member panels, mailbox timeline,
  permission history).
- **Mesh management entry points:** all three — a form-based mesh builder (direct
  `create`), `start`/`stop` buttons (direct `MeshManager`), **and** the master agent
  (natural language).
- **Tech stack:** Bun native bundler + React + TypeScript (no Vite). Plain CSS with
  CSS variables (no Tailwind). Only added runtime deps: `react`, `react-dom`.
- **Visual style:** minimal black/white terminal aesthetic; status conveyed with
  restrained ANSI-style accents (green=running, amber=starting, red=dead,
  gray=stopped) and `●/○` glyphs.
- **Conversation rendering:** **aggregated**, not one line per raw event (see
  "Transcript aggregation").
- **Included web-only capabilities** (API already supports them): direct chat with
  member agents (`promptAgent`) and per-agent permission-mode switching (`setMode`).

## Scope

**In scope:** everything above; a single-user, localhost web console; server-side
authoritative state with snapshot-on-connect so a browser refresh/reconnect recovers
full state; removal of the TUI.

**Out of scope:** multi-user auth / remote-exposure hardening; persistence beyond the
existing `.mesh/` on-disk definitions; mesh-of-meshes federation; mobile layout.

## Architecture

```
   Browser (React SPA)
       │  REST (commands)        ┌───────────────────────────────────────┐
       │  WebSocket (snapshot +  │  Parent process (bun run src/main.ts)  │
       │  transcript/event deltas)│                                       │
       ▼                          │   WebServer (Bun.serve)               │
   Bun.serve  ───────────────────┤     ├─ static: bundled React app      │
                                  │     └─ WebGateway (authoritative      │
                                  │          state + fan-out)             │
                                  │              │                        │
                                  │        MeshManager  ←→ MasterAgent    │
                                  │              │  (manager.on / master.on)│
                                  └──────────────┼────────────────────────┘
                                                 │ unchanged: Unix socket per mesh
                                          mesh-host subprocess(es)
```

The web server runs **in the parent process**, so `WebGateway` subscribes to
`manager.on((name, event) => …)` and `master.on((update) => …)` directly — exactly
the two streams the TUI consumed. No change to `MeshManager`, `MasterAgent`,
`mesh-host`, the NDJSON protocol, or the per-mesh subprocess lifecycle.

### Why in-process (vs. alternatives)

- **In-process Bun server (chosen):** zero backend change, preserves process-per-mesh
  isolation, single launch command, fewest deps.
- *Separate API + Vite frontend:* two processes, CORS, conflicts with the
  Bun-native / minimal-deps decision.
- *Stateless pass-through server:* simplest server but a browser refresh goes blank
  and late-joining clients miss prior events. Rejected — server-side state is needed.

## Backend

### `WebGateway` (`src/web/gateway.ts`) — testable core, no HTTP

Wraps a `MeshManager` and an optional `MasterAgent`. Responsibilities:

1. **Subscribe** to `manager.on` and `master.on`; fold their streams into authoritative
   state.
2. **Maintain authoritative state** (see model below), including the **aggregated
   transcript** per conversation and bounded ring buffers for discrete event lists.
3. **Expose command methods** that delegate to the manager/master:
   `listMeshes`, `configOf`, `defineMesh`, `startMesh`, `stopMesh`, `reloadDefinitions`,
   `promptRouter`, `promptAgent`, `resolvePermission`, `setMode`, `promptMaster`.
4. **Fan-out:** `subscribe(client) → unsubscribe`. On subscribe, push a full
   `snapshot`; thereafter push deltas (`transcript.upsert/patch`, `activity`,
   `permission.add/remove`, `mesh.status`, `mesh.list`, `agent.status`,
   `master.status`).

`WebGateway` has **no HTTP/WS dependency** — it takes plain callbacks — so it is unit-
tested against a mock manager or the `echo-host` / `crash-host` fixtures without real
agents or a real socket.

### Authoritative state model

```ts
type ConvRef =
  | { scope: "master" }
  | { scope: "agent"; mesh: string; agent: AgentId };   // router chat == router agent's conv

interface MeshSummary {
  name: string;
  defined: boolean;
  status: MeshStatus;                 // "stopped" | "starting" | "running" | "dead"
  router: AgentId;
  agents: { id: AgentId; harness: HarnessId; role: AgentRole; status: AgentStatus }[];
}

interface ActivityEntry {            // discrete events — stay a list, NOT aggregated
  id: string; ts: string;
  kind: "mail" | "interrupt" | "permission_resolved" | "log";
  text: string;                       // pre-rendered summary
  data: MeshEvent;                    // original event for detail/expansion
}

interface PermissionReq {            // mirrors MeshEvent "permission"
  requestId: string; agent: AgentId; question: string;
  options: { id: string; name: string; kind?: string }[]; ts: string;
}

interface ResolvedPermission {
  requestId: string; agent: AgentId; optionId: string;
  by: "human" | "timeout"; ts: string;
}

interface MailEntry { id: string; ts: string; from: AgentId; to: AgentId; body: string; }

interface GatewayState {
  meshes: MeshSummary[];
  master: { status: "absent" | "starting" | "ready" | "stopped"; transcript: TranscriptItem[] };
  perMesh: Record<string, {
    config: MeshConfig;
    transcripts: Record<AgentId, TranscriptItem[]>;   // one per agent (incl. router)
    activity: ActivityEntry[];          // ring buffer (cap, e.g. 500)
    mail: MailEntry[];                  // ring buffer
    pending: PermissionReq[];
    history: ResolvedPermission[];      // ring buffer
  }>;
}
```

Ring buffers cap memory; transcripts cap per-conversation item count (e.g. 1000),
dropping oldest. Caps are explicit constants so truncation is intentional, not silent.

### Transcript aggregation (`src/web/transcript.ts`) — pure reducer, TDD

Folds the raw ACP `SessionUpdate` stream (carried by `MeshEvent { kind:"update" }`
and by master updates) into an ordered, identity-keyed transcript. This is the core
of "aggregated rendering."

```ts
type TranscriptItem =
  | { id: string; kind: "message"; role: "user" | "agent"; text: string; ts: string; complete: boolean }
  | { id: string; kind: "thought"; text: string; ts: string; complete: boolean }
  | { id: string; kind: "tool_call"; toolCallId: string; title: string; toolKind?: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      output?: string; ts: string; updatedTs: string };

type TranscriptOp =
  | { op: "upsert"; item: TranscriptItem }
  | { op: "patch"; id: string; patch: Partial<TranscriptItem> };

// Pure: no I/O, no Date.now() inside (caller passes `now`).
function reduceTranscript(
  items: TranscriptItem[],
  update: unknown,            // ACP SessionUpdate (or our user-echo)
  now: string,
): { items: TranscriptItem[]; ops: TranscriptOp[] };
```

**Aggregation rules:**

- `agent_message_chunk`: if the last item is an **open** agent message
  (`kind:"message", role:"agent", complete:false`), append its text and emit
  `patch`; else create a new open agent message and emit `upsert`.
- `agent_thought_chunk`: same coalescing into an open `thought` item.
- user prompt (echoed locally when we call `promptRouter`/`promptAgent`/`promptMaster`):
  append a completed `message` with `role:"user"`.
- `tool_call`: **close** any open message/thought (mark `complete`), then `upsert` a
  `tool_call` item keyed by `toolCallId` (status from the update, default `pending`).
- `tool_call_update`: find the item by `toolCallId` and `patch` its `status` / appended
  `output` / `updatedTs`. If no matching item exists yet (update-before-create),
  `upsert` a new one.
- turn end (prompt resolves / `stopReason`): mark all open items `complete`.
- unknown update kinds: ignored for the transcript (still available in raw event logs).

The gateway applies `ops` to its stored `items` and broadcasts each op as a
`transcript.upsert` / `transcript.patch` WS message tagged with its `ConvRef`. The
snapshot ships the already-aggregated `items`, so the client never sees raw chunks.

This reducer is the primary TDD target: tests cover chunk coalescing, interleaved
text + tool calls, multi-update tool-call merging, update-before-create, and turn
boundaries — driven by recorded/synthetic ACP `SessionUpdate` samples.

### REST API (commands; `src/web/server.ts`)

| Method & path | Calls | Notes |
| --- | --- | --- |
| `GET /api/state` | gateway snapshot | optional non-WS bootstrap / debugging |
| `GET /api/meshes` | `listMeshes()` | |
| `GET /api/meshes/:name/config` | `configOf(name)` | |
| `POST /api/meshes` | `defineMesh(config)` | body = `MeshConfig`; validated server-side |
| `POST /api/meshes/:name/start` | `startMesh(name)` | |
| `POST /api/meshes/:name/stop` | `stopMesh(name)` | |
| `POST /api/meshes/reload` | `loadDefinitions()` | Ctrl-R equivalent |
| `POST /api/meshes/:name/prompt` | `promptRouter(name, text)` | router chat |
| `POST /api/meshes/:name/agents/:id/prompt` | `promptAgent(name, id, text)` | member chat |
| `POST /api/meshes/:name/agents/:id/mode` | `setMode(name, id, modeId)` | |
| `POST /api/meshes/:name/permissions/:requestId/resolve` | `resolvePermission(...)` | body `{ optionId }` |
| `POST /api/master/prompt` | `master.prompt(text)` | 409 if master absent |

Validation reuses `mesh-validate`. Errors return `{ error: { message, code } }` with a
4xx/5xx status; the client surfaces them inline / as a toast. Commands echo the user
turn into the relevant transcript immediately (optimistic), matching the TUI.

### WebSocket protocol (`/ws`) — server → client

One multiplexed socket. Connect → receive `snapshot`; then deltas. Client→server is
limited to keepalive pings (all commands go through REST), keeping the socket simple.

```ts
type ServerMsg =
  | { t: "snapshot"; state: GatewayState }   // the GatewayState shape above
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
```

A `mail` `MeshEvent` emits **both** an `activity` (kind `"mail"`, the unified
cross-cutting log line) and a `mail` (structured `MailEntry` for the focused mailbox
view) — intentional, the two views serve different purposes.

The client reducer applies these to the same shape as the snapshot. Reconnect: the
client re-opens the socket with exponential backoff and replaces its store with the
fresh `snapshot` — no incremental replay needed.

### `main.ts` bootstrap changes

Replace the TUI bootstrap with: parse `--port` (default `7317`); construct
`MeshManager`; if a master is configured, construct + `start()` `MasterAgent` with an
`onUpdate` wired into the gateway; `await manager.loadDefinitions()`; construct
`WebGateway(manager, master)`; start `WebServer` (`Bun.serve`); print the URL.
`SIGINT` / shutdown still calls `manager.stopAll()` + `master?.stop()` to reap all
subprocesses (no orphans). Master remains optional — gateway reports
`master.status:"absent"` and the UI degrades gracefully.

## Frontend (`src/web/client/`)

### Build & serve

Bun's native fullstack server bundles a TSX entry. `index.html` imports
`index.tsx`; `Bun.serve` serves the bundled assets and the API/WS routes from the
same origin (no CORS). `tsconfig` gets `"jsx": "react-jsx"`. Dev uses Bun's hot
reload. Dependencies added: `react`, `react-dom` (+ `@types/react`, `@types/react-dom`
dev).

### Store

A minimal hand-rolled store via `useSyncExternalStore` (no Redux/zustand). A single WS
connection feeds a reducer over `ServerMsg`; selectors feed components; command
dispatchers call REST. This keeps the dependency surface to just React.

### Component tree

```
<AppShell>                         // top bar: title · master status · ws status · [new mesh] [reload]
  <Sidebar>                        // TUI "top context", always visible
    <MeshList/>                    // rows: ▸ selection · name · ●/○ status · [start]/[stop]
    <NewMeshButton/> → <MeshBuilderModal/>   // form: name, agents[id,harness,role,project], edges
    <MasterChat/>                  // aggregated transcript + input (promptMaster); greyed if absent
  <MeshDetail mesh={selected}>     // TUI "mesh context" + PoC enhancements
    <MeshHeader/>                  // name · router · status · [stop]
    <TopologyGraph/>               // hand-rolled SVG: nodes=agents (status color), edges=config.edges
    <RouterChat/>                  // aggregated transcript of the router agent; input (promptRouter); Ctrl-F fullscreen
    <AgentPanels/>                 // tabs per member: aggregated transcript; input (promptAgent); mode ▾ (setMode)
    <PermissionPrompts/>           // cards: question + options; click or digit 1–9 → resolvePermission
    <ActivityTimeline/>            // mail/interrupt/permission_resolved/log with timestamps
    <MailboxTimeline/>             // mail entries for this mesh
    <PermissionHistory/>           // resolved permissions
  </MeshDetail>
</AppShell>
```

Layout (black/white terminal aesthetic): left sidebar (mesh list + master) fixed;
right detail pane for the selected mesh; the topology graph spans the top of the
detail pane, router chat + agent panels side by side below, permission prompts pinned
above the activity/mail timelines.

### Conversation rendering (aggregated)

`RouterChat`, `AgentPanels`, and `MasterChat` all render the aggregated
`TranscriptItem[]` (never raw chunks):

- **message** → a text block; `role:"user"` right/bold-prefixed, `role:"agent"`
  left/dim-prefixed. Open (`complete:false`) messages show a blinking caret.
- **thought** → a collapsible "thinking" block, collapsed by default.
- **tool_call** → a card with the tool title + kind, a status badge
  (pending/in_progress/completed/failed), and collapsible output; the same card
  updates in place as `tool_call_update`s patch it.

### Topology graph

Hand-rolled SVG, deterministic radial layout (router centered, members on a ring),
zero graph-lib dependency. Nodes are monospace-labeled boxes colored by
`agent_status`; `config.edges` render as arrowed lines (directed mail permissions).
Clicking a node selects that agent's panel; an `interrupt` briefly flashes the target.

### Mesh builder form

A modal form to compose a `MeshConfig`: mesh name, a repeatable agent rows
(`id`, `harness` ∈ codex/opencode/claude, `role` ∈ router/member, `project`), and
edges (from→to among defined agent ids). Client-side validation mirrors
`mesh-validate` (exactly one router, unique ids, relative `project`, edges reference
existing ids); submit → `POST /api/meshes`; server re-validates.

### Keyboard parity

A `useKeyboard` hook preserves TUI keybindings as web shortcuts: `1–9` resolve the
focused/first pending permission; `Tab` cycles mesh selection; `Ctrl-R` reload defs;
`Esc` returns to overview (deselect mesh); `Ctrl-F` fullscreen the focused chat pane.
Page close triggers a best-effort beacon; the server reaps subprocesses on its own
shutdown regardless.

## Mapping to the 6 PoC verification points

1. **≥2 heterogeneous agents, live streams** → topology nodes + per-agent panels with
   live aggregated transcripts and status dots.
2. **Router + members + interaction graph** → topology graph renders the router and
   `config.edges` literally; header names the router.
3. **Inter-agent mailbox** → `MailboxTimeline` + activity entries
   `mail <from> → <to>: <body>`.
4. **Permission escalation → human decision → op runs** → `PermissionPrompts` cards;
   resolve by click or digit; outcome lands in `PermissionHistory` + activity.
5. **Router interrupt → cancel** → activity entry `interrupt <from> → <target>` + node
   flash.
6. **All of 1–5 live** → WS-driven, real-time; snapshot on connect for refresh
   recovery.

## TUI removal

- Delete `src/tui/app.ts`, `src/tui/line-editor.ts`, `src/tui/line-editor.test.ts`.
- `main.ts`: swap TUI bootstrap for the web server bootstrap.
- `package.json`: `"mesh"` script launches the web server (same `bun run src/main.ts`,
  now serving the WebUI); `e2e` and smokes unchanged.
- `README.md`: update the architecture diagram (`Human ⇄ WebUI`) and the Run section
  (browser URL + the WebUI's controls); keep the PTY-history note.
- The ACP-update summarization logic currently inline in `tui/app.ts` is superseded by
  `src/web/transcript.ts` (richer, structured) — not ported verbatim.

## Error handling & edge cases

- **mesh-host crash** → `manager` emits `agent_status:dead` / mesh `status:dead`; node
  turns red, activity logs it; `start` is offered again.
- **Master absent / not started** → `master.status:"absent"`; master panel greyed,
  `POST /api/master/prompt` returns 409.
- **Invalid mesh config** → `defineMesh` rejects; server returns a 4xx with the
  validation message; the builder shows it inline.
- **Permission timeout** → control plane emits `permission_resolved{by:"timeout"}`;
  prompt card disappears and the timeout is recorded in history.
- **WS disconnect** → client backoff-reconnects and reloads the snapshot.
- **Shutdown** → `stopAll()` + `master?.stop()` reap the whole subprocess tree.

## Testing strategy

- **`transcript.ts` reducer** — exhaustive `bun test` units (the highest-value target):
  coalescing, interleaving, tool-call merge, update-before-create, turn boundaries.
- **`WebGateway`** — integration tests against a mock `MeshManager` and against the
  `echo-host` / `crash-host` fixtures: snapshot correctness, delta emission, command
  delegation, permission add/remove, status transitions.
- **REST handlers** — request/response + error-shape tests over `Bun.serve` (in-process
  fetch).
- **Client store reducer** — pure unit tests applying `ServerMsg` sequences.
- **End-to-end smoke (optional)** — Playwright against the running server with a
  fixture mesh: create → start → see status/topology → resolve a permission.
- Methodology: TDD for the reducer, gateway, and store (per repo conventions).

## Dependencies

Added runtime: `react`, `react-dom`. Added dev: `@types/react`, `@types/react-dom`.
No Vite, no Tailwind, no graph library, no state-management library. Everything else
is Bun stdlib + existing deps.
