# Agent Mesh

A PoC **Agent Mesh Controller**: one global control plane orchestrates a mesh of
heterogeneous coding agents that connect over the **Agent Client Protocol (ACP)**.

> The earlier PTY-based prototype (`src/pty-*.ts`, `src/codex-*-test.ts`,
> `src/mock-agent.ts`, `src/work-packet.ts`) is retained as history but is no
> longer used — PTY proved too unstable and was replaced by ACP.

## Architecture

```
   Human ⇄ TUI ⇄ Control Plane (single global process)
                  ├─ ACP Client        — sole "muscle": one connection per agent
                  ├─ Orchestrator      — deterministic (no master agent yet)
                  ├─ Mesh Services MCP — HTTP MCP server injected into every agent
                  └─ Mailbox (NDJSON) + event bus
                         │ ACP over stdio (one client, all agents)
                   Mesh "demo"
                   ├─ router      (claude)   — gateway: talks to user/other meshes, coordinates
                   ├─ codex-1     (codex)    — member
                   └─ opencode-1  (opencode) — member
```

- **Single global control plane** = a deterministic orchestrator + the *only*
  ACP client. It spawns and drives every agent in every mesh.
- **Every agent is a homogeneous ACP agent.** "Router" is just a member agent
  *designated* as the mesh's gateway. Per the three-layer composition
  **Project × Harness × Instance**, each agent is `(cwd, harness, ACP session)`.
- **Agents get mesh tools via an injected HTTP MCP server** (`mcpServers` at
  `session/new`): `send_mail`, `check_mail`, and — Router-only — `interrupt`,
  `mesh_status`.
- **Inter-agent messaging is async mailbox only** (no peer interrupts). Only the
  Router may `interrupt` a member → the control plane issues `session/cancel`.
- **Permission requests** (`session/request_permission`) escalate to a human via
  the TUI; internal mesh-tool calls are pre-authorized.

Harnesses (all real ACP agents): `codex` → `codex-acp`, `opencode` →
`opencode acp`, `claude` → `claude-agent-acp`.

## Run

```bash
bun install
```

Agents run in `test_mesh_0/` and use your existing local logins (codex via
ChatGPT, opencode via its provider, claude via the Claude Agent SDK).

**Interactive TUI** — boot the demo mesh and watch it live:

```bash
bun run mesh
```

Keys: `Tab` switch agent · `1`-`9` decide a pending permission · `d` run a live
demo (mail + a permission you approve) · `q` quit.

**Headless end-to-end verification** of all 6 PoC points:

```bash
bun run e2e
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

- Spec: `docs/superpowers/specs/2026-06-06-agent-mesh-poc-design.md`
- Plan: `docs/superpowers/plans/2026-06-06-agent-mesh-poc.md`
