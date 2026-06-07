# Agent Mesh

A PoC **Agent Mesh Controller**: a parent control plane manages multiple meshes of
heterogeneous coding agents that connect over the **Agent Client Protocol (ACP)**.
An optional LLM **master agent** accepts natural-language instructions to create,
start, and stop meshes; a **React + Bun web console** lets you drive the whole
control plane — chat with the master agent and individual mesh Routers, build/
start/stop meshes, watch a live topology, resolve permission escalations, and
follow inter-agent mail and activity in real time.

> The earlier PTY-based prototype (`src/pty-*.ts`, `src/codex-*-test.ts`,
> `src/mock-agent.ts`, `src/work-packet.ts`) is retained as history but is no
> longer used — PTY proved too unstable and was replaced by ACP.

## Architecture

```
   Browser (React SPA)  ⇄  REST + one WebSocket (snapshot + deltas)
        │
   Bun web server (src/web/server.ts)  ── WebGateway (authoritative state,
        │                                   aggregated transcripts, fan-out)
        │                                        │
        │                                 MeshManager  ←→  optional MasterAgent (claude ACP)
        │                                    │   │            └─ mesh-control MCP server
        │                                    │   │               (create/start/stop/list_meshes)
        │                                    │   │
        │             [Unix socket .mesh/run/<name>.sock — NDJSON]
        │                                    │
    mesh-host subprocess (one per running mesh)
    └─ ControlPlane for that mesh
       ├─ ACP Client (one connection per agent)
       ├─ Mesh Services MCP — send_mail / check_mail / interrupt
       └─ Mailbox (NDJSON) + event bus
            │ ACP over stdio
      Mesh "demo"
      ├─ router      (claude)    — gateway: talks to user/other meshes
      ├─ codex-1     (codex)     — member
      └─ opencode-1  (opencode)  — member
```

The web server runs **in the parent process** (it's the new face of the same
parent that owns `MeshManager`); the subprocess-per-mesh model is unchanged.

**Parent process** owns `MeshManager` (deterministic lifecycle: validate, persist,
spawn, supervise, aggregate events), an optional `MasterAgent` (a claude ACP agent
with `create_mesh` / `start_mesh` / `stop_mesh` / `list_meshes` MCP tools), and the
**web server** (`src/web/`). A testable `WebGateway` folds the manager + master
event streams into authoritative state — including **aggregated transcripts** (raw
ACP `SessionUpdate` chunks are coalesced into message bubbles and tool-call cards,
not one line per event) — and fans a snapshot + deltas out to the browser over one
WebSocket; commands go over REST.

**Each running mesh** lives in its own `mesh-host` subprocess (`src/mesh-host.ts`)
that wraps the existing `ControlPlane` for that one mesh. The parent supervises it
over a per-mesh Unix domain socket (`.mesh/run/<name>.sock`) speaking an NDJSON
control protocol (`src/protocol.ts`). A crash in one mesh is contained; `stop`
reaps the entire subprocess tree (no orphans).

**Mesh definitions** persist under `.mesh/meshes/<name>.json` and survive a parent
restart. Running state does not — each mesh must be started explicitly after the
parent boots.

**Agents are ACP-first.** "Router" is just a member agent designated as the mesh's
gateway. Per the three-layer composition **Project × Harness × Instance**, each
agent is `(cwd, harness, ACP session)`. Agents get mesh tools via an injected HTTP
MCP server (`mcpServers` at `session/new`): `send_mail`, `check_mail`, and —
Router-only — `interrupt`, `mesh_status`. Internal mesh-tool calls are
pre-authorized; only non-mesh operations escalate to a human permission prompt.

Harnesses (all real ACP agents): `codex` → `codex-acp`, `opencode` →
`opencode acp`, `claude` → `claude-agent-acp`.

## Run

```bash
bun install
```

Agents run in `test_mesh_0/` and use your existing local logins (codex via
ChatGPT, opencode via its provider, claude via the Claude Agent SDK).

**Web console** — master agent + multi-mesh manager + live control:

```bash
bun run mesh          # → opens http://localhost:7317
# bun run mesh --port 8080      # custom port (or MESH_WEB_PORT=8080)
# bun run mesh --no-master      # skip the master agent
# bun run mesh --fake           # self-contained scripted demo (no real agents)
```

**Split deployment** (one binary, two processes — controlled by separate commands).
`mesh` (above) is the combined single process; to run the web tier and the backend
engine separately:

```bash
bun run backend                          # control plane: REST + WS on :7300 (no frontend)
#   = bun run mesh backend [--port 7300] [--fake] [--no-master]
bun run web                              # SPA + reverse-proxy /api + /ws → backend, on :7317
#   = bun run mesh web [--port 7317] [--backend http://localhost:7300]
```

The **backend** owns `MeshManager` + the mesh-host subprocesses and exposes only the
API/WS; the **web** tier serves the React SPA and proxies to the backend (same browser
origin). The backend can run headless (scripting, restarting the UI without disturbing
running meshes); the web tier carries zero backend code and vice-versa.

Open the printed URL. The console is a master/detail layout:

- **Left** — the mesh list (status dot, `start`/`stop`, `+ new mesh` form) and the
  **master-agent chat** (create/start/stop meshes in natural language).
- **Right** (selected mesh) — `start` / `stop` / `edit` / `delete`; a live
  **topology** graph; the **router chat**; per-member **agent panels** (direct chat,
  permission-mode control, and an **interrupt** button to cancel a runaway turn);
  **permission cards** (click an option, or press `1`–`9`); and **activity / mailbox /
  permission-history** timelines.
- **Aggregated transcripts** — streamed chunks coalesce into message bubbles; tool
  calls render as one card (input / affected files / output, status updated in place);
  agent **plans** show as a live checklist. Command failures surface as toasts.
- **Keys**: `↑`/`↓` select mesh · `f` fullscreen router chat · `n` new mesh ·
  `r` reload definitions · `1`–`9` resolve a pending permission · `esc` back. (Web
  equivalents of the old TUI keys — `Ctrl-R`/`Ctrl-F`/`Tab` are left to the browser.)

Closing the server (`Ctrl-C` in the terminal) reaps every mesh subprocess (no orphans).

`--fake` mode streams a full scripted scenario (messages, a thought, a tool call,
inter-agent mail, a permission, an interrupt) so you can explore every widget with
no agents or logins.

**Tests & verification:**

```bash
bun test                              # unit/integration (transcript reducer, gateway, api, store…)
bun run src/web/server.smoke.ts       # combined http + ws + bundler smoke
bun run src/web/split.smoke.ts        # split: backend + web reverse-proxy (rest/post/ws)
bun run src/web/browser.e2e.ts        # headless-browser e2e over --fake (every widget)
bun run src/web/mobile.e2e.ts         # mobile (390x844) e2e: stack nav + segments
bun run src/web/split-cli.e2e.ts      # two real processes (mesh backend + mesh web), browser via proxy
bun run src/web/real.e2e.ts           # real claude+codex+opencode mesh on a fictional project
bun run e2e                           # headless 6-PoC-point verification through MeshManager
bun run src/flows/mesh-lifecycle.smoke.ts   # real-agent lifecycle smoke
```

## The 6 PoC verification points

1. Control plane spawns + manages ≥2 heterogeneous ACP agents with live event streams.
2. A hardwired mesh: a Router (gateway) + members, with an interaction graph.
3. Inter-agent mailbox: agent A `send_mail` → B, B is woken and processes it.
4. A member's permission request escalates to a human decision, then the op runs.
5. Router `interrupt` → control-plane `session/cancel` on a member.
6. The web console renders 1–5 live (topology, aggregated transcripts, permission
   cards, mailbox/activity timelines), driven by one WebSocket.

## Design docs

- Spec (original PoC): `docs/superpowers/specs/2026-06-06-agent-mesh-poc-design.md`
- Plan (original PoC): `docs/superpowers/plans/2026-06-06-agent-mesh-poc.md`
- Spec (multi-mesh): `docs/superpowers/specs/2026-06-06-control-agent-multi-mesh-design.md`
- Plan (multi-mesh): `docs/superpowers/plans/2026-06-06-control-agent-multi-mesh.md`
- Spec (web console): `docs/superpowers/specs/2026-06-07-mesh-webui-design.md`
- Plan (web console): `docs/superpowers/plans/2026-06-07-mesh-webui.md`
