## Why

When a mesh-host daemon dies — cold restart (the only way to deploy host-core changes), crash, machine reboot, or idle-lease expiry — every agent subprocess dies with it, and on the next start each agent is spawned with a fresh `session/new`. The team's accumulated conversational context is lost. Work *products* survive (git commits, mailbox NDJSON, worktrees), but the agents come back with amnesia and the router must manually re-brief them. Since we self-develop this controller, every cold-restart deploy wipes the whole mesh's in-flight context.

A spike (2026-06-08, with raw ACP-message evidence) proved that codex, claude, kimi, and opencode adapters all advertise `loadSession: true` and survive a `kill -9` cross-process round-trip: after the adapter is killed and respawned, `session/load(savedId)` restores the agent's real conversation. This rides the underlying CLI's on-disk session store, not our transcript — so it is faithful (no lossy summary, no fabricated tool blocks) and cheap for us to wire.

## What Changes

- Persist, per agent, the ACP `sessionId` plus the `cwd` it was created in (alongside the already-known harness/model/mode/effort) so the daemon can reconstruct a session-defining `session/load` call after a restart.
- On agent (re)spawn, when the harness advertises `loadSession` **and** a saved session id exists for that agent, call `session/load(sessionId, cwd)` instead of `session/new`. Otherwise start fresh with `session/new`.
- Fall back to `session/new` whenever resume cannot be guaranteed: harness does not advertise `loadSession`, no saved id, `session/load` errors (e.g. `resourceNotFound`), **or** the first prompt after a load fails. (The first-prompt-failure path matters because a provider/quota error can break a session even when the capability is advertised — observed with opencode's default model.)
- Only auto-resume agents that were expected to be alive. Agents in a mesh the user deliberately stopped, or one reaped by idle-lease expiry, must NOT be auto-resurrected — otherwise `kill` is meaningless. The persisted record carries a `meshExpectedAlive` flag set/cleared deterministically across every lifecycle path.
- No briefing/transcript snapshot, no rolling summary, no re-injection. Resume is purely the ACP `session/load` mechanism with a fresh-start fallback. (The earlier "Tier 1 snapshot" idea is explicitly dropped.)

## Capabilities

### New Capabilities
- `session-resume`: persisting per-agent ACP session identity and restoring it via `session/load` on restart, capability-gated per harness, with deterministic fresh-start fallback and kill-intent-respecting auto-respawn.

### Modified Capabilities
<!-- None: there is no existing spec under openspec/specs/ for agent session lifecycle; this is the first capability spec covering it. -->

## Impact

- **Code**: `src/control-plane.ts` (spawn path that today always calls `newSession()`); `src/acp/client.ts` (add a `loadSession` call wrapping ACP `session/load`, capture/expose `sessionId` + `cwd`); `src/harness.ts` or capability detection (read `loadSession` from the adapter `initialize` response); sessions file under `<base>/.agent-mesh/run/` (add `sessionId`, `cwd`, `meshExpectedAlive`); manager/host respawn path.
- **Dependencies**: relies on the underlying CLI session stores (`~/.codex/sessions`, `~/.claude/projects`, `~/.kimi-code/sessions`, opencode's local db) remaining intact across restarts — a new external coupling we do not own. Resume breaks if those are pruned or if the CLI's session format changes.
- **Process model**: extends the existing detachable-daemon reconnect story from "UI/state replay" to "agent conversation continuity". Because `cwd` is part of session identity, **a mesh's worktree path must be stable** for resume to work — path changes silently disable resume (fall back to fresh).
- **Dev/prod isolation**: unchanged boundary; all verification on DEV (temp instance on port 10020, root `~/.agent-mesh-dev`), never the prod store. Resume reads/writes only under the active `--root`.

## Non-goals

- Restoring in-flight execution state: interrupted/incomplete tool calls, long-running commands, and pending ACP permission requests are treated as lost. Resume restores the *conversation*, not a process/tool-call continuation.
- Any transcript snapshotting, rolling summary, or briefing re-injection fallback.
- Migrating or repairing incompatible/older underlying CLI session files.
