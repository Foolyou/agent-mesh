# Design: Mesh / single-agent "switch to new session"

Date: 2026-06-09
Branch: `feat/new-session-switch`
Worktree: `.worktrees/mesh-dev-2`

## Goal

Let the operator reset an agent's conversation context by switching it to a fresh
ACP session (`session/new`), discarding the current session. Two entry points:

1. **Single agent** — reset one agent's session.
2. **One-click whole mesh** — reset every agent in a mesh.

Must correctly handle both running and not-running agents, and must not violate
laziness / kill-intent invariants.

This is the inverse of the existing session-*resume* feature
(`docs`/`openspec/changes/add-session-resume/`), which calls `loadSession` on
restart. Here we force a fresh `session/new` and invalidate the saved session id.

## Semantics

"Switch to new session" = **process-level fresh start** for running agents
(reuse the existing `forceFresh` respawn path), and **invalidate the persisted
session id** for not-running agents so their *next* spawn is fresh.

### Single agent: `newSession(meshName, agentId)`

Branch on the agent's live state:

- **Running / has a live connection** (status `ready` | `spawning` | `working`):
  call `ensureSpawned(id, { forceFresh: true, drainPendingMail: false })`.
  This kills the harness subprocess, respawns it, calls `session/new`, and
  persists the new session record. An in-flight turn is cancelled implicitly by
  the subprocess kill — no separate interrupt needed.

- **Not running** (status `cold` | `lazy`-cold | `dead`): **never spawn.**
  Spawning here would resurrect a deliberately-killed or lazily-deferred agent,
  violating kill-intent and laziness invariants (see memory:
  `feedback-no-unsafe-mode-gating`, the three non-negotiable resume rules).
  Instead, clear only the `sessionId` field in the persisted session record
  (keep `cwd` / `harness` / `model` / `mode` / `effort`). On the next spawn
  (wake via mail or manual), `saved.sessionId` is empty → `spawnAgent` falls
  through to `session/new` automatically.

### One-click whole mesh: `newAllSessions(meshName)`

- **Mesh daemon running**: a single control-plane method `newAllSessions()`
  applies the per-agent logic above to every agent (running ones respawn fresh,
  not-running ones get their session id cleared).

- **Mesh fully stopped** (no daemon): no control-plane to talk to. The manager
  clears the on-disk session records for all agents directly via
  session-storage, so the next mesh start is fully fresh.

## Transcript handling

On a successful switch, inject a synthetic `—— 新会话 ——` ("New session")
divider item into the agent's transcript via the event stream; the gateway folds
it into `pm.transcripts[agentId]`. History is preserved (charter:
results/context remain traceable) while giving a clear "context was reset" cue.
Inject the divider for not-running agents too, so the reset is visibly
acknowledged even when nothing respawns.

## Confirmation

The web client shows a confirm dialog before POSTing, for **both** entry points:

- Single: "确定要重置 X 的会话吗？"
- Mesh: "确定要重置 mesh 里全部 N 个 agent 的会话吗？"

## Plumbing (mirrors the existing `setMode` chain)

| Layer | Change |
| --- | --- |
| `src/protocol.ts` | Add `ParentMsg` frames `{ t: "newSession"; target }` and `{ t: "newAllSessions" }`. |
| `src/web/api.ts` | `POST /api/meshes/:name/agents/:id/session` (single); `POST /api/meshes/:name/session` (all). |
| `src/web/gateway.ts` | `newAgentSession(name, id)` / `newAllSessions(name)` → manager, then refresh. |
| `src/mesh-manager.ts` | Delegate to running daemon via host-client; for a stopped mesh, clear on-disk session records directly. |
| `src/mesh-host-client.ts` | `newSession(target)` / `newAllSessions()` send NDJSON frames. |
| `src/mesh-host.ts` | Handle the new frames → control-plane methods. |
| `src/control-plane.ts` | `newSession(id)` (live-vs-cold logic + divider emit); `newAllSessions()`. |
| `src/session-storage.ts` | `clearAgentSession(runDir, mesh, agentId)` — clears `sessionId`, keeps other fields; and a mesh-wide clear for the stopped-mesh path. |
| `src/web/client/store.ts` | `newAgentSession` / `newAllSessions` commands. |
| Web UI | Per-agent button near mode/model/interrupt controls; mesh-level "全部新会话" button. |

## Testing (TDD)

- **Unit — control-plane**: live agent `newSession` → new `sessionId`, old session
  record replaced; cold/dead agent `newSession` → no spawn, persisted `sessionId`
  cleared; `newAllSessions` covers a mix.
- **Unit — session-storage**: `clearAgentSession` clears only `sessionId`,
  preserves the rest; mesh-wide clear zeroes every agent.
- **e2e** (`src/web/*.e2e.ts`, Playwright): button → confirm dialog → divider
  appears in transcript; one-click resets all agents; assert the underlying
  `sessionId` actually changed (via `fixtures/resume-acp` or a mock harness).

## Out of scope

- No briefing/summary re-injection (resume feature already settled that as
  dropped).
- No change to resume behavior; this feature only adds the explicit fresh-start
  path and the session-id invalidation it depends on.

## Invariants honored

- Not-running agents are never resurrected by this feature.
- User-killed (`dead`) agents stay dead; only their next *intentional* wake is
  fresh.
- Session storage stays atomic (tmp+rename) and 0600, per the resume rules.
