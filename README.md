# Agent Mesh

Agent Mesh is a local control plane for coordinating multiple coding agents as a
team. It lets you define agent groups, route work through a mesh Router, watch
their conversations and tool activity in real time, and keep the whole system
operable from a web console.

Instead of juggling several independent agent terminals, Agent Mesh gives you a
single place to create teams, start and stop them, pass work between agents,
review outputs, resolve permissions, and recover from controller restarts.

The project is evolving quickly, but it is already usable for local development
and for evaluating multi-agent coding workflows.

## What You Can Do

- **Build agent teams**: define meshes with a Router, member agents, directed
  mail edges, per-agent roles, harnesses, projects, and instructions.
- **Mix agent runtimes**: run heterogeneous ACP agents such as Codex, Claude,
  opencode, and Kimi in one mesh.
- **Operate from a web console**: create, edit, start, stop, and delete meshes;
  chat with the Mesh Assistant, Routers, and member agents; inspect topology and
  live status.
- **Coordinate agent work**: agents can send mail, check their inbox, wake lazy
  peers, and expose their activity through mailbox and timeline views.
- **Keep humans in control**: permission requests become explicit cards in the
  UI, and Routers can interrupt runaway member turns.
- **Review outputs as work happens**: transcripts coalesce streamed chunks into
  readable messages, tool-call cards, file links, image attachments, and live
  plan checklists.
- **Run safely while developing**: use fake mode for a no-login demo, split dev
  and production roots, run the web tier separately from the backend, or ship a
  single self-contained binary.

## Why It Exists

Single-agent CLIs are useful, but real work often wants a small team:

- one agent to talk to the user,
- one or more agents to implement or investigate,
- another agent to review,
- a way to pass context without copy/paste,
- a live view of what everyone is doing,
- and a control plane that survives ordinary restarts.

Agent Mesh turns those pieces into an explicit operating environment. A mesh is
a directed team of agents. The Router is the user-facing gateway. Member agents
receive delegated work, report back through mail, and stay observable through the
same console.

## Quick Start

```bash
bun install
bun run mesh
```

Open the printed URL, usually:

```text
http://localhost:7317
```

Agents use your existing local logins for their harnesses, such as Codex,
Claude, opencode, or Kimi.

For a self-contained demo with no real agent logins:

```bash
bun run mesh --fake
```

Common options:

| Command | Purpose |
|---|---|
| `bun run mesh` | Run the combined web console and backend. |
| `bun run mesh --fake` | Run a scripted demo with fake agents. |
| `bun run mesh --no-master` | Skip the natural-language Mesh Assistant. |
| `bun run mesh --master-harness claude` | Choose the Mesh Assistant harness. Supported: `codex`, `claude`, `opencode`, `kimi`. |
| `bun run mesh --port 8080` | Serve the console on another port. |
| `bun run mesh --root ~/work/mesh` | Store mesh data under another base directory. |

The default data root is `~/.agent-mesh`. Passing `--root <dir>` stores data in
`<dir>/.agent-mesh`.

## Web Console Tour

The console is built for operating live agent teams:

- **Mesh list**: see every defined mesh, status dots, start/stop controls, and a
  form for creating or editing meshes.
- **Mesh Assistant**: ask a configured agent to create, update, start, stop, or
  inspect meshes in natural language.
- **Topology view**: inspect the Router/member graph and how agents are allowed
  to communicate.
- **Router chat**: talk to the mesh gateway, the agent responsible for routing
  user intent into the team.
- **Member panels**: chat directly with an agent, inspect its mode/model/effort
  controls, and interrupt a turn when needed.
- **Permission cards**: approve or deny escalated operations directly in the UI.
- **Activity, mailbox, and history timelines**: follow inter-agent messages,
  status changes, permission decisions, and other control-plane events.
- **Readable transcripts**: streamed updates fold into message bubbles, tool-call
  cards, generated-file links, images, and live plan checklists.

## Core Capabilities

### Build Agent Teams

A mesh is a named team with one Router and any number of member agents. Each
agent has a harness, project directory, role, optional instructions, and runtime
settings. Edges define who can mail whom, so collaboration is explicit rather
than an untracked side channel.

### Coordinate Work Between Agents

Agents receive mesh MCP tools at session start:

- `send_mail` delegates or reports to another reachable agent.
- `check_mail` reads new mail addressed to the agent.
- `mesh_status` lets the Router inspect live peer state.
- `interrupt` lets the Router cancel a member's current turn.

The web console turns these into visible mailbox and activity timelines, so the
team's coordination is inspectable.

### Keep Human Decisions Explicit

Agent operations outside the trusted mesh-control surface still escalate through
the underlying harness permission flow. Agent Mesh surfaces those requests as
permission cards, records the decision history, and keeps the agent turn visible
while it waits.

### Review Work Products

Transcripts are aggregated for reading rather than dumped as raw event streams.
Tool calls render as cards with input, status, output, and affected files.
Markdown links to generated files can open through the file viewer, and image
attachments can be uploaded to prompts.

### Survive Controller Restarts

Running meshes live in detachable mesh-host processes. The parent backend can
restart, reconnect to running hosts, replay recent state, and resume control
without treating every restart as a lost session.

### Package and Deploy Simply

The same codebase can run as:

- a source-mode dev server,
- a split backend plus web frontend,
- or one compiled binary that embeds the web app and re-execs itself for mesh
  hosts.

## How It Works

```text
Browser web console
   ⇅ REST commands + WebSocket state stream
Bun web server
   ⇅
WebGateway
   ⇅
MeshManager ── optional Mesh Assistant agent
   ⇅
mesh-host subprocess per running mesh
   ⇅
ControlPlane
   ├─ ACP client per agent
   ├─ mesh MCP tools: send_mail / check_mail / mesh_status / interrupt
   └─ mailbox + event stream
```

The important pieces:

- **ACP-first agents**: Codex, Claude, opencode, Kimi, and other compatible
  harnesses connect through Agent Client Protocol sessions.
- **Parent process**: owns mesh definitions, lifecycle commands, web API, state
  aggregation, and optional Mesh Assistant control.
- **Mesh host subprocesses**: isolate each running mesh so one crashed mesh does
  not take down the whole controller.
- **WebGateway**: folds raw manager and agent events into authoritative UI state,
  aggregated transcripts, and WebSocket deltas.
- **Mesh MCP tools**: give agents a controlled collaboration surface without
  exposing the mailbox implementation directly.
- **Persistent root**: mesh definitions, mailbox data, sockets, service records,
  and session metadata live under one root, defaulting to `~/.agent-mesh`.

The old PTY prototype files remain in the repository as history, but the current
system is ACP-based.

## Running Modes

### Combined Console

```bash
bun run mesh
```

This starts the backend and web console in one process.

### Split Backend and Web Tier

```bash
bun run backend
bun run web
```

The backend owns `MeshManager` and mesh-host subprocesses. The web tier serves
the React app and reverse-proxies `/api` and `/ws` to the backend. This is useful
when restarting the UI should not disturb the backend.

### Single Binary

```bash
bun run build
./dist/mesh
```

The compiled binary serves the embedded SPA and re-execs itself as each per-mesh
host. The same binary also supports service commands:

```bash
mesh up
mesh status
mesh logs -f
mesh restart
mesh restart --cold
mesh down --cold
```

## Verification

Primary check:

```bash
bun test
```

Useful targeted checks:

```bash
bun run src/web/server.smoke.ts       # combined HTTP + WS + bundler smoke
bun run src/web/split.smoke.ts        # split backend/web reverse proxy
bun run src/web/browser.e2e.ts        # browser e2e over --fake
bun run src/web/mobile.e2e.ts         # mobile layout e2e
bun run src/web/theme.e2e.ts          # theme switching and custom palette
bun run src/web/split-cli.e2e.ts      # real split CLI processes
bun run e2e                           # headless MeshManager PoC verification
```

The broader test suite covers mesh validation, lifecycle, mailbox behavior,
session resume metadata, the web gateway, transcript aggregation, upload/file
serving safety, and browser-facing UI behavior.

## Project Status

The original proof-of-concept goals are implemented and covered by tests:

1. Spawn and manage multiple heterogeneous ACP agents.
2. Run a hardwired Router/member mesh with explicit communication edges.
3. Deliver inter-agent mail and wake recipients.
4. Escalate member permission requests to a human decision.
5. Let Routers interrupt member turns.
6. Render the above live in the web console.

The project is still actively evolving. Current work focuses on making the
controller more durable, making agent outputs easier to inspect, and tightening
the operator experience.
