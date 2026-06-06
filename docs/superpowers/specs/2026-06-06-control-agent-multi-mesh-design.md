# Control Agent + Multi-Mesh Lifecycle + Router Chat — Design

Date: 2026-06-06
Status: Approved (brainstorming) — pending implementation plan

## Goal

Extend the PoC so a human can, from one process:

1. **Master ("总控") agent** — give natural-language instructions to an LLM agent
   that creates meshes and starts/stops them.
2. **Mesh lifecycle** — the control plane can define, validate, persist, start,
   and stop multiple meshes. This capability is **independent** of the master
   agent; the master agent is an additive, optional smart layer over it.
3. **Router chat UI** — enter a running mesh and converse with its Router.
   (Direct chat with non-router members is explicitly out of scope.)

## Background / current state

- `ControlPlane` (`src/control-plane.ts`) is hard-bound to **one** `MeshConfig`
  passed in its constructor and `start()`s every agent at once. It is the sole
  ACP client, runs the mesh-services MCP, owns the mailbox + event bus, and
  arbitrates permission escalations. It already exposes `on()`, `prompt()`,
  `resolveDecision()`, `setMode()` (via `agent()`), `cancel()`, and `stop()`.
- `main.ts` boots exactly `DEMO_MESH` and renders a **read-only** TUI (events +
  permission keypresses; no text input).
- The README already flags the gap: "Orchestrator — deterministic (no master
  agent yet)."
- Process-tree teardown is hardened: `killTree` + signal/`exit`/`uncaughtException`
  handlers reap the full descendant tree (`src/acp/client.ts`).

## Chosen architecture: process-per-mesh (Approach C)

Each running mesh lives in its **own child process**, supervised by a parent
control-plane host. Rationale:

- **Reuses existing investment.** `stop_mesh` becomes "kill the subprocess
  tree" — directly leveraging the hardened `killTree`/signal machinery.
- **Small refactor.** Today's `ControlPlane` already drives exactly one mesh, so
  it becomes the subprocess body almost verbatim.
- **Fault isolation.** A hung/crashing agent or wedged ACP client takes down
  only its mesh, not the control plane or sibling meshes. Each mesh gets its own
  event loop, signal handlers, `LIVE` set, and console-noise patching.

Trade-off accepted: cross-process plumbing (a control protocol + permission
escalation that hops the process boundary).

### Process & isolation model

```
Parent process (control-plane host)
├─ MeshManager        — deterministic core: define/validate/persist/start/stop/aggregate events
├─ Master Agent       — optional LLM (claude ACP) + mesh-control MCP tools
├─ TUI                — master chat + mesh list + per-mesh Router chat
└─ Map<name, MeshHostClient>
        │ one Unix domain socket per mesh: .mesh/run/<name>.sock
        ▼
mesh-host subprocess (one per running mesh)
└─ ControlPlane(config)   ← today's code, ~unchanged, drives this one mesh
   ├─ ACP client (all agents in this mesh)
   ├─ mesh-services MCP (send_mail / check_mail / interrupt / mesh_status)
   ├─ mailbox + permission custody
   └─ socket bridge: event bus → socket / socket commands → ControlPlane methods
```

The parent comes up first, creates a listening Unix socket per mesh it is about
to start, spawns the child with the socket path passed via env, and the child
dials back. One accepted connection per mesh. The child's `stderr` may be
inherited for debugging.

**Why Unix socket (not stdio NDJSON):** the ACP library emits stray
`console.log`/`console.error` (the TUI already silences these). In a subprocess
that noise would land on stdout and corrupt a stdout-based control protocol. A
dedicated Unix socket isolates the control protocol from console noise.

## Components

### MeshManager (parent, deterministic core)

The real global control plane. Usable without the master agent — callable from
the TUI, tests, and e2e.

```ts
defineMesh(config): void          // validate + write .mesh/meshes/<name>.json (does NOT start)
loadDefinitions(): MeshConfig[]   // read persisted definitions at startup
startMesh(name): Promise<void>    // create socket → spawn mesh-host → await ready
stopMesh(name): Promise<void>     // send stop → on timeout killTree → clean up socket
listMeshes(): { name, defined, status }[]   // status: stopped | starting | running | dead
promptRouter(name, text): Promise<void>
resolvePermission(name, requestId, optionId): void
setMode(name, agentId, modeId): Promise<void>
on((name, event: MeshEvent) => void): () => void   // aggregated bus, tagged with mesh name
```

**Deterministic validation rules** (run in `defineMesh`; this is the control
plane's check over an LLM-generated topology):

1. `name` unique and filesystem-safe.
2. `agents` non-empty.
3. **Exactly one** agent with `role: "router"`.
4. Every agent's `harness` ∈ `{codex, opencode, claude}`.
5. Agent `id`s unique within the mesh.
6. Every edge `[from, to]` references existing agent ids.
7. Each agent's `project` is a relative path.

Violations throw an error carrying the reason (surfaced to the master agent as
tool-result text).

### mesh-host subprocess + control protocol

`src/mesh-host.ts`: reads env (socket path + serialized config), connects the
socket, `new ControlPlane(config)`, `await cp.start()`, then bridges. The
`ControlPlane` class is essentially unchanged.

Protocol: newline-delimited JSON (NDJSON) over the Unix socket, bidirectional,
with partial-line buffering on both ends.

- child → parent: `{t:"ready"}` · `{t:"event", event}` · `{t:"stopped"}`
- parent → child: `{t:"prompt", target, text}` · `{t:"resolve", requestId, optionId}`
  · `{t:"setMode", target, modeId}` · `{t:"stop"}`

On child crash / socket close, the parent marks the mesh `dead`, emits an event,
and cleans up the socket file. The user may restart it.

### MeshHostClient (parent side)

Wraps one subprocess + its socket connection. Typed methods mirror the
parent→child commands; it parses child→parent frames and forwards events to the
MeshManager's aggregated bus. `MeshManager` holds `Map<name, MeshHostClient>`.

### Master Agent (optional smart layer)

One `AcpAgentConnection` (claude) in the parent, with a new injected HTTP MCP
server `mesh-control` (modeled on `createMeshServicesServer`). Tools:

- `create_mesh(spec)` — LLM supplies the topology; handler calls
  `MeshManager.defineMesh` (which validates).
- `start_mesh(name)` · `stop_mesh(name)` · `list_meshes()`.

Handlers call MeshManager directly (in-process). Validation/lifecycle errors are
returned as tool text so the LLM can correct and retry. The system runs fully
with this layer disabled. **This milestone: lifecycle only** — the master agent
does not route messages into meshes.

### TUI (parent)

Extends the current read-only TUI with input:

- **Top context:** chat with the master agent (text input line) + a mesh list
  with live `status` (name / router / agent count).
- **Enter a mesh** (select + Enter): **Router chat pane is primary**, showing the
  user↔Router conversation (user input → `promptRouter`; Router
  `agent_message_chunk` updates stream back). **Fullscreen toggle** (`f`);
  `esc` returns to the top context.
- That mesh's **permission escalations** still render and are resolvable by key
  (routed through `resolvePermission`, which crosses the process boundary).
- New capability: a real input-line editor (today only single-key handling).
- User↔Router uses **direct prompt turns** (Router is the gateway), not the
  mailbox. Direct chat with non-router members is out of scope.

## Data flow

- **Create + start:** user speaks to master → LLM calls `create_mesh` →
  `defineMesh` (validate + persist) → LLM/user calls `start_mesh` → spawn
  subprocess → `ready` → events stream into the TUI.
- **Chat Router:** TUI input → `promptRouter` → `{t:"prompt", target: router}`
  → child `cp.prompt` → ACP turn → update events back over the socket → TUI.
- **Permission:** member requests → child emits `permission` event → socket →
  TUI → human key → `resolvePermission` → `{t:"resolve"}` → child
  `cp.resolveDecision`.

## Error handling

- Validation failure → `defineMesh` throws; master-agent tool returns the error
  text.
- `start_mesh` on an already-running mesh → error; `stop_mesh` on a non-running
  mesh → no-op/error.
- Graceful `stop` timeout → `killTree` fallback (no orphaned process trees).
- Socket framing: partial-line buffering; on malformed frame, log and skip.
- Child crash / socket close → mesh marked `dead`, socket file cleaned up.

## Testing

1. **Unit:** validation rules (pure function); persistence round-trip
   (define → read back); protocol encode/decode + partial-line framing.
2. **Smoke:** spawn a mesh-host subprocess with a minimal config; assert
   `ready`, event relay over the socket, and that `stop` leaves **no orphan
   processes** (ties back to the process-tree teardown guarantee).
3. **e2e:** the existing 6 PoC points still pass when the demo mesh is driven
   through MeshManager + a subprocess; add a new
   create → start → prompt-router → stop lifecycle check.

## Scope / YAGNI for this milestone

- Master agent does **create / start / stop / list** only — not message routing.
- User chats with the **Router** only — not other members.
- Only mesh **definitions** are persisted; running state does not survive a
  parent-process restart.
- No auth / multi-user.

## Affected / new files (indicative)

- New: `src/mesh-manager.ts`, `src/mesh-host.ts`, `src/mesh-host-client.ts`,
  `src/mcp/mesh-control.ts`, `src/master-agent.ts`, `src/protocol.ts`.
- Changed: `src/control-plane.ts` (minor — used as subprocess body),
  `src/tui/app.ts` (input line + mesh list + Router chat pane), `src/main.ts`
  (boot MeshManager + master agent + TUI), `src/e2e.ts` (drive via MeshManager).
- Reused as-is: `src/acp/client.ts`, `src/mcp/mesh-services.ts`,
  `src/mailbox.ts`, `src/mesh.ts`, `src/harness.ts`.
</content>
</invoke>
