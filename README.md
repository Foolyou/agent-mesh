# Agent Mesh

A PoC **Agent Mesh Controller**: a parent control plane manages multiple meshes of
heterogeneous coding agents that connect over the **Agent Client Protocol (ACP)**.
An optional LLM **master agent** accepts natural-language instructions to create,
start, and stop meshes; an interactive **TUI** lets you chat with both the master
agent and individual mesh Routers.

> The earlier PTY-based prototype (`src/pty-*.ts`, `src/codex-*-test.ts`,
> `src/mock-agent.ts`, `src/work-packet.ts`) is retained as history but is no
> longer used — PTY proved too unstable and was replaced by ACP.

## Architecture

```
   Human ⇄ TUI ─────────────────────────────────────────────────┐
               │                                                  │
        MeshManager  ←→  optional MasterAgent (claude ACP)       │
           │   │              └─ mesh-control MCP server         │
           │   │                   (create/start/stop/list_mesh) │
           │   │                                                  │
           │  [Unix socket .mesh/run/<name>.sock — NDJSON]       │
           │                                                      │
    mesh-host subprocess (one per running mesh)                   │
    └─ ControlPlane for that mesh                                 │
       ├─ ACP Client (one connection per agent)                   │
       ├─ Mesh Services MCP — send_mail / check_mail / interrupt  │
       └─ Mailbox (NDJSON) + event bus ───────────────────────────┘
            │ ACP over stdio
      Mesh "demo"
      ├─ router      (claude)    — gateway: talks to user/other meshes
      ├─ codex-1     (codex)     — member
      └─ opencode-1  (opencode)  — member
```

**Parent process** owns `MeshManager` (deterministic lifecycle: validate, persist,
spawn, supervise, aggregate events), an optional `MasterAgent` (a claude ACP agent
with `create_mesh` / `start_mesh` / `stop_mesh` / `list_mesh` MCP tools), and the
interactive TUI.

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

**Interactive control** — master agent + multi-mesh manager + chat TUI:

```bash
bun run mesh
```

**Top context** (default): type an instruction and press Enter to send it to the
master agent (it has `create_mesh` / `start_mesh` / `stop_mesh` / `list_mesh`
tools). `Tab` cycles through the mesh list; type `/enter` and press Enter to open
the selected mesh's Router chat.

**Mesh context**: chat directly with the running mesh's Router. `Ctrl-F` toggles
fullscreen; `Esc` returns to the top context.

**Anywhere**: digit keys (`1`–`9`) resolve a pending permission prompt; `Ctrl-C`
quits and reaps all mesh subprocesses. `Ctrl-R` reloads mesh definitions from disk.

**Headless end-to-end verification** (all 6 PoC points, driven through MeshManager):

```bash
bun run e2e
```

**Lifecycle smoke** (real agents — define → start → prompt router → stop):

```bash
bun run src/flows/mesh-lifecycle.smoke.ts
```

**Unit tests:**

```bash
bun test
```

## The 6 PoC verification points

1. Control plane spawns + manages ≥2 heterogeneous ACP agents with live event streams.
2. A hardwired mesh: a Router (gateway) + members, with an interaction graph.
3. Inter-agent mailbox: agent A `send_mail` → B, B is woken and processes it.
4. A member's permission request escalates to a human decision, then the op runs.
5. Router `interrupt` → control-plane `session/cancel` on a member.
6. The TUI renders 1–5 live.

## Design docs

- Spec (original PoC): `docs/superpowers/specs/2026-06-06-agent-mesh-poc-design.md`
- Plan (original PoC): `docs/superpowers/plans/2026-06-06-agent-mesh-poc.md`
- Spec (multi-mesh): `docs/superpowers/specs/2026-06-06-control-agent-multi-mesh-design.md`
- Plan (multi-mesh): `docs/superpowers/plans/2026-06-06-control-agent-multi-mesh.md`
