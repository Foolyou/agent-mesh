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
bun run mesh:run
```

Open the printed URL, usually:

```text
http://localhost:7317
```

Agents use your existing local logins for their harnesses, such as Codex,
Claude, opencode, or Kimi.

Common options:

| Command | Purpose |
|---|---|
| `bun run mesh` | Print service status and usage; starts nothing. |
| `bun run mesh:run` | Run the combined web console and API in the foreground. |
| `bun run mesh:run --no-assistant` | Skip the natural-language Mesh Assistant. |
| `bun run mesh:run --assistant-harness claude` | Choose the Mesh Assistant harness. Supported: `codex`, `claude`, `opencode`, `kimi`. |
| `bun run mesh:run --port 8080` | Serve the console on another port. |
| `bun run mesh:run --root ~/work/mesh` | Store mesh data under another base directory. |

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

### Feishu Gateway

The backend can optionally bridge one Feishu/Lark bot to mesh Routers. It uses
the official `@larksuiteoapi/node-sdk` long-connection client, so local and
private deployments do not need a public webhook endpoint. Agent Mesh supports
one bound bot at a time; binding a new bot replaces the previous credentials and
creates fresh mesh group bindings for the new bot.

Feishu is disabled by default. The backend watches
`<root>/channels/feishu.json`; creating or editing that file after startup
starts, restarts, or stops the channel without restarting Agent Mesh.

```json
{
  "enabled": true,
  "appId": "cli_xxx",
  "appSecret": "xxx",
  "domain": "feishu",
  "botMentionId": "ou_xxx",
  "botName": "MeshBot",
  "requireMention": true,
  "allowSenders": ["ou_xxx"],
  "outbound": { "minIntervalMs": 500 },
  "bindings": [
    { "mesh": "feishu-poc", "chatId": "oc_xxx", "name": "feishu-poc · Mesh 联调" }
  ]
}
```

Open the web UI's **Feishu** panel to bind a bot with the SDK one-click
provisioning flow. The panel shows the current bot, displays the returned link
and QR code while authorization is pending, and lists every mesh group binding.
When Feishu is configured, startup sync creates groups for existing meshes, and
creating a new mesh creates its group automatically.

For group chats, `botMentionId` is preferred for the @ gate because display
names can change. `botName` remains a fallback and is also used to strip a
leading rendered mention from the routed prompt. Set `requireMention` to
`false` only for explicitly trusted bound groups; the Feishu app must also have
the all-group-message permission (`im:message.group_msg`) or non-@ messages will
not be delivered to the backend. Creating mesh groups requires Feishu group
permissions such as `im:chat`. When a valid inbound message arrives and the
mapped mesh is stopped, the Feishu channel starts that mesh before routing the
message to its router.

Messages from `allowSenders` can also control the bound mesh with explicit
commands:

- `/mesh status`
- `/mesh start`
- `/mesh stop`
- `/mesh restart`
- `/mesh new-session`
- `/mesh help`

Useful API endpoints:

- `GET /api/channels/feishu/status`
- `POST /api/channels/feishu/reload`
- `POST /api/channels/feishu/provision` starts the SDK one-click app creation
  flow and returns a verification link plus QR code data URL.
- `GET /api/channels/feishu/provision/:jobId` checks the creation job. When the
  scan completes, credentials are written to `channels/feishu.json`.
- `POST /api/channels/feishu/sync` creates missing Feishu groups for current
  meshes.
- `POST /api/channels/feishu/meshes/:mesh/group` creates one missing group.

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
bun run mesh:run
```

This starts the web console and API in one foreground process. Use `mesh run`
from the installed binary. If no port is supplied, `mesh run` chooses a free
port above 12345.

### Single Binary

```bash
bun run build
./dist/mesh
```

The compiled binary serves the embedded SPA and re-execs itself as each per-mesh
host. For the local operator install path, `scripts/update.sh` verifies the
current source, builds a compiled binary, and installs it as `~/.local/bin/mesh`
with rollback backups under `~/.local/state/mesh/backups`.

Platform updater entrypoints:

```bash
# Linux
scripts/update.sh

# macOS
scripts/update-macos.sh
```

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts\update.ps1
```

On Windows, the updater installs `mesh.exe` to
`%LOCALAPPDATA%\Programs\agent-mesh\bin` by default and warns if that directory
is not on `PATH`.

The same binary also runs the control plane as a background service. `mesh up`/`restart` start the
**combined web+API control plane** (SPA + REST + WS in one process). A hot `mesh down` stops the
control plane but **leaves the mesh daemons running** (so the next `mesh up` reattaches to them);
`--cold` also reaps the daemons.

```bash
mesh up                 # start the combined web+API control plane in the background
mesh status             # control-plane up/down + running meshes
mesh logs -f
mesh restart            # hot restart (mesh daemons kept)
mesh restart --cold     # also reap the mesh daemons
mesh down --cold        # stop the control plane and reap the mesh daemons
```

Other commands: `mesh help` (usage), `mesh ps [-v]` / `mesh doctor` (read-only diagnostics),
`mesh channels feishu list|approve|revoke` (external chat channels), `mesh device …` /
`mesh auth …` (device + key authorization). Global flags (`--root`, `--port`, …) work before
or after the command.

## Verification

Primary check:

```bash
bun test
```

Useful targeted checks:

```bash
bun run src/web/server.smoke.ts       # combined HTTP + WS + bundler smoke
bun run src/web/split.smoke.ts        # split backend/web reverse proxy
bun run src/web/browser.e2e.ts        # browser e2e
bun run src/web/mobile.e2e.ts         # mobile layout e2e
bun run src/web/theme.e2e.ts          # theme switching and custom palette
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
