# Agent Mesh Controller — PoC Design

Date: 2026-06-06
Status: Approved (brainstorming) → implementing

## Context

We are building an **Agent Mesh Controller**: a control plane that orchestrates
meshes of heterogeneous coding agents. The earlier prototype in this repo drove
agents through a real PTY (`src/pty-*.ts`) and coordinated them via a file
mailbox. PTY proved too unstable, so we are **abandoning PTY entirely** and
adopting the **Agent Client Protocol (ACP)** — JSON-RPC over stdio — as the
integration substrate for every agent.

This document specifies a **Proof of Concept** whose only goal is to prove the
core architecture end-to-end with real agents. It is intentionally minimal:
control plane and mesh are hardwired; there is no master ("总控") LLM agent yet;
the UI is a read-only Bun TUI.

## Topology — single global control plane (star)

```
        TUI (Bun)  ⇄  Control Plane (single process)
                       ├─ ACP Client        (sole "muscle": owns every agent connection)
                       ├─ Orchestrator      (deterministic; NO master agent in PoC)
                       ├─ Mesh Services MCP (exposes mesh tools to agents)
                       └─ Mailbox (NDJSON) + event bus
                              │ ACP (stdio, one connection per agent)
              ┌───────────────┼───────────────┐
            Mesh "demo" (hardwired)
            ├─ Router Agent  (gateway; one of the three harnesses)
            └─ 1–2 member Agents
```

- **One global control plane.** It is the *only* ACP **Client**; it holds the
  connections to every agent in every mesh and is the only component that can
  issue `session/prompt` / `session/cancel`.
- **All agents are homogeneous ACP Agents.** "Router" is not a special process —
  it is a member agent *designated* as the mesh's gateway (talks to the user /
  other meshes; coordinates members).
- **No master agent in PoC (decision "D").** The orchestrator is deterministic;
  permission/authorization requests escalate to the human via the TUI. The
  escalation hook is built so a master agent can be added later. The fractal
  goal (mesh-of-meshes) is explicitly future work.

## Three-layer composition: Project × Harness × Instance

- **Project** = an agent's working directory (cwd). For the PoC every agent runs
  in **`test_mesh_0/`** under this repo.
- **Harness** = which ACP agent to launch (`HarnessSpec { id, command, args }`,
  pluggable):
  - `codex`    → spawn `codex-acp`            (@zed-industries/codex-acp v0.14.0)
  - `opencode` → spawn `opencode acp`         (native, v1.16.2)
  - `claude`   → spawn `claude-agent-acp`
- **Instance** = a concrete ACP session the client spawns for a (project,
  harness) pair (`initialize` + `session/new`).
- PoC mesh is a **hardwired config**, e.g. Router=`claude`, members=`codex` +
  `opencode`, all in `test_mesh_0/`.

## Components (single responsibility, independently testable)

| Module | Responsibility | Depends on |
|---|---|---|
| `src/acp/client.ts` | ACP client: spawn agent, JSON-RPC framing, `initialize`/`session/*`, subscribe `session/update`, answer `fs/*` + `session/request_permission` | stdio |
| `src/acp/types.ts` | ACP protocol types (prefer re-export from `@zed-industries/agent-client-protocol`) | — |
| `src/harness.ts` | Harness registry: codex/opencode/claude → launch command | — |
| `src/mesh.ts` | Mesh model: members, Router role, interaction graph (who may mail whom) | client |
| `src/control-plane.ts` | Orchestrator: build mesh, spawn instances, route user input to Router, forward permission requests, execute Router's `interrupt`/`send_mail` | client, mesh, mcp |
| `src/mcp/mesh-services.ts` | Tools exposed to agents: `send_mail`, `check_mail`, (Router-only) `interrupt`, `mesh_status` | control-plane |
| `src/mailbox.ts` (extend) | NDJSON, add `to` / `mesh` addressing fields | — |
| `src/tui/app.ts` | Bun TUI: control-plane / mesh / agent views + live event stream | event bus |

## Key mechanism: how tools reach agents

ACP's `session/new` lets the **client** pass `mcpServers`. The control plane runs
a **Mesh Services MCP server** and injects it into every agent's session, so each
agent gains `send_mail` / `check_mail` (Router additionally gets `interrupt`,
`mesh_status`). Tool calls flow agent → MCP server (= control plane) → mesh op.

- **Primary** approach: MCP injection via `mcpServers`. **Confirmed by spike:**
  all three harnesses advertise `mcpCapabilities.http = true`, so we host ONE
  HTTP MCP server (the Mesh Services server) and inject it into every session;
  per-agent identity is carried in a header. The text-envelope fallback is **not
  needed**.

### Spike results (2026-06-06)

`src/spike-acp.ts` connected the Zed `@zed-industries/agent-client-protocol`
v0.4.5 client (PROTOCOL_VERSION 1) to each harness in `test_mesh_0/` and ran
`initialize → newSession → prompt`:

| Harness | initialize | newSession | streaming | http MCP | auth |
|---|---|---|---|---|---|
| codex (codex-acp 0.14.0) | ✅ | ✅ | ✅ `agent_message_chunk`, `end_turn` | ✅ | ✅ ChatGPT login |
| opencode (1.16.2) | ✅ | ✅ | ✅ `agent_thought_chunk` | ✅ | ✅ Zen default model |
| claude (claude-agent-acp 0.37.0) | ✅ | ✅ | ✅ `agent_message_chunk` | ✅ | ✅ none required |

**Interop note:** the Zed client lib zod-validates inbound `session/update`
notifications and **rejects vendor extensions** (e.g. claude's `usage_update`)
with `-32602 Invalid params`. This is **non-fatal** — the lib catches it, the
connection survives, and all schema-known updates (`agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`) plus
`session/request_permission` (a request, not a notification) flow normally. PoC
accepts dropping `usage_update` with a logged warning; switch to a permissive
inbound parser later if vendor-specific updates are needed.

## Data flow (maps to the 6 verification points)

1. Control plane `initialize` + `session/new` launches codex/opencode/claude and
   subscribes to each `session/update` (message/thought chunks, tool_call …) →
   TUI renders live. **(points 1, 6)**
2. Hardwired mesh: Router + members spawned, roles + interaction graph
   registered. **(2)**
3. Member A calls `send_mail(to:B)` → MCP → control plane writes addressed
   mailbox → control plane wakes B (prompt injection or B `check_mail`) → B
   processes. **(3)**
4. Member calls `session/request_permission` → ACP client catches it →
   orchestrator escalates to TUI → human keypress allow/deny → result returned to
   the agent per ACP. **(4)**
5. Router calls `interrupt(member)` → MCP → control plane → ACP client
   `session/cancel` on that member. Members have no such tool and no peer
   connection, so they cannot interrupt each other. **(5)**

## Error handling

- Agent process crash/exit: client detects stdio close, marks instance `dead`,
  TUI shows red, orchestrator stops routing to it.
- ACP request timeout: each `session/prompt` has a timeout; on timeout emit an
  `error` event; Router/human may cancel or retry.
- Permission request with no decider: PoC defaults to **deny on timeout**
  (conservative); TUI shows a pending-decision queue.
- Mailbox write failure / corrupt line: skip bad lines on read (existing
  `readMailboxEvents` tolerance).

## Testing / acceptance

- **Spike: DONE** (see "Spike results" above). `src/spike-acp.ts` proved
  `initialize → newSession → prompt → message chunk` and `http` MCP capability
  for all three harnesses; all are authenticated. Architecture de-risked.
- **End-to-end script:** start the hardwired mesh → trigger A→B mailbox → trigger
  one permission request (human keypress) → trigger a Router interrupt; all
  visible in the TUI. An `e2e` script drives this and asserts the corresponding
  records appear in the mailbox / event log.
- Run the spike against all three harnesses to confirm each event stream parses.

## Out of scope (explicitly not in PoC)

- Master ("总控") agent intelligent decisioning (D: only the escalate-to-human
  hook exists).
- Manual "send a message to a single agent" UI action.
- Dynamic mesh creation from the UI (hardwired config only).
- Web UI, mesh-of-meshes federation, persistence/recovery.

## Existing code

- Reuse + extend `src/mailbox.ts` (NDJSON event log).
- `src/pty-*.ts`, `src/mock-agent.ts`, `src/codex-*-test.ts`, `src/work-packet.ts`
  are PTY-era and **not used** by the PoC; left in the repo as history.
