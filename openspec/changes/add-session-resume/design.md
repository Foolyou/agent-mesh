## Context

Today `ControlPlane` always calls `newSession()` when spawning an agent (src/control-plane.ts:211). The ACP `sessionId` (src/acp/client.ts) lives only in the adapter process's memory; when the mesh-host daemon dies, every agent subprocess dies and comes back amnesiac. The detachable-daemon design already restores UI/state by replaying an in-memory event ring on backend reconnect, but it does NOT restore agent conversation across a daemon (cold) restart.

A spike on 2026-06-08 (raw ACP-message evidence) established the load-bearing facts:
- codex-acp 0.14.0, claude-agent-acp 0.37.0, kimi 0.11.0, opencode 1.16.2 all advertise `loadSession: true`.
- codex / claude / kimi / opencode all pass a `kill -9` cross-process round-trip: kill the adapter, respawn, `session/load(savedId)` restores the conversation (verified by a secret-recall probe). opencode confirmed on a follow-up using `deepseek/deepseek-chat`.
- Resume rides the **underlying CLI's on-disk session store**, not our transcript. The ACP `sessionId` equals the underlying CLI session id (codex `~/.codex/sessions/.../rollout-*-<id>.jsonl`, claude `~/.claude/projects/<cwd-encoded>/<id>.jsonl`, kimi `~/.kimi-code/sessions`, opencode local db).
- `cwd` is part of session identity: claude fingerprints session-defining params and encodes cwd into the storage path; kimi records workDir. `session/load` requires `{cwd, mcpServers, sessionId}`.
- Capability advertised != resume guaranteed: opencode's default model `opencode/big-pickle` is quota/429-prone and can break the first prompt even though `loadSession` is advertised. The model must be persisted and restored (opencode restores it via ACP `session/set_model` after load; the CLI's `-m` flag is not usable — `opencode -m <model> acp` just prints help and exits).

Existing code relevant to the design:
- `src/mesh-registry.ts`: `<root>/run/<mesh>.json` is a **daemon liveness registry** (`{name, pid, socketPath, proto, startedAt}`) used by `mesh ps`/`mesh kill`/backend reattach. Its `listLiveRecords()` prunes dead-pid entries — a cold-restart removes the entry entirely. Extension is NOT safe for per-agent resume metadata (prune would destroy it on the very cold restart resume is meant to survive).
- `src/control-plane.ts`: Spawn path (`initialize()` then `newSession([mcpServers])`) then applies mode/model from the session result. There is no per-agent kill API — stops are mesh-level (`MeshHostDaemon.stop()`, `ControlPlane.stop()`), and the daemon stop path currently has no reason differentiation.
- `src/acp/client.ts`: `newSession(opts)` sets `this.sessionId` and returns the session setup result (containing `modes`, `configOptions`). No `loadSession` wrapper exists.
- Mesh briefing: injected via `compose()` on the first prompt to a fresh agent. `briefed` is an in-memory `Set<agentId>`, wiped on cold restart.

## Goals / Non-Goals

**Goals:**
- Persist per-agent `{sessionId, cwd, harness, model, mode, effort}` and a mesh-level `meshExpectedAlive` flag durably and atomically, in a file independent of the daemon liveness registry.
- On daemon start with `meshExpectedAlive: true`, auto-respawn all agents and attempt resume via `session/load` for capable harnesses with a saved id; otherwise fresh `session/new`.
- `loadSession` and `newSession` share a common result shape so the caller (ControlPlane) does not branch on resume vs fresh for mode/model initialization.
- Fall back to fresh on any resume failure (load error or first-prompt failure); retry the prompt once against the fresh session.
- Prevent duplicate mesh briefing on resumed sessions; only inject briefing on fresh (or fresh-fallback) sessions.
- On deliberate mesh stop or idle-lease expiry, clear `meshExpectedAlive`; never auto-resurrect agents after an explicit stop.
- Prompting a stopped agent implicitly starts it fresh with `session/new` and sets `meshExpectedAlive = true` (explicit engagement = resurrection intent).
- Never auto-resurrect deliberately-killed or idle-reaped agents.

**Non-Goals:**
- Restoring in-flight tool calls, long-running commands, or pending permission requests.
- Any transcript snapshot / rolling summary / briefing re-injection (the dropped "Tier 1").
- Repairing incompatible/older underlying CLI session formats.
- Per-agent kill API (MVP uses mesh-level stop; see Open Questions).

## Decisions

**D1 — Reuse ACP `session/load`, do not build our own transcript persistence.**
Why: the spike proved the adapters + underlying CLIs already persist faithful session state across process death. `session/load` restores the agent's *real* history, avoiding the lossy-summary and fabricated-tool-block hazards of a snapshot approach. Alternative (own transcript snapshot + briefing re-injection) was considered and rejected by the user: more code, more risk (secret redaction, semantic confusion), lower fidelity.

**D2 — Capability gate from the `initialize` response, attempt is not a guarantee.**
Detect `loadSession` per harness from the adapter's `initialize` result and store it on the connection (e.g. `supportsLoadSession`). Resume is attempted only when `supportsLoadSession && savedId`. Independently, treat resume as best-effort: a successful attempt still falls back to fresh on load error or first-prompt failure. Why: opencode showed advertise != works; gating on capability alone would strand an agent in a broken session.

**D3 — Persist `cwd` as part of session identity; pass original `cwd` to `session/load`.**
Because the underlying stores key on cwd, loading with a different cwd would miss or recreate the session. Consequence: a mesh's worktree path must be stable for resume; if it changes, resume silently falls back to fresh (acceptable — degrades to current behavior).

**D4 — Mesh-level `meshExpectedAlive` flag drives auto-respawn.**
The sessions file carries a `meshExpectedAlive` boolean (mesh-level, not per-agent). State transitions:
- daemon reaches ready → `meshExpectedAlive = true`
- deliberate mesh stop (user kill) → `meshExpectedAlive = false`
- idle-lease expiry stop → `meshExpectedAlive = false`
- crash / cold restart / hot restart of the daemon → flag is **left as-is**
On daemon start, if `meshExpectedAlive` is true, auto-respawn ALL configured agents (attempting resume per harness capability). If false, no agents are auto-respawned.

Rationale: current code has no per-agent stop/start API — all lifecycle is mesh-level (daemon stop, idle lease, mesh kill). A mesh-level flag matches the real lifecycle. Per-agent granularity (with an unreachable "false" state) would mislead readers into expecting per-agent resume control that doesn't exist. When per-agent kill/start is added later, this can migrate to per-agent fields without breaking the sessions file format.

Skipped-agent behavior (when `meshExpectedAlive = false`): prompting a dead agent implicitly starts it with a fresh `session/new` and sets `meshExpectedAlive = true`. This is an explicit engagement (resurrection intent), not an auto-respawn — the caller is actively choosing to use the agent.

**D5 — Separate storage file, not the daemon liveness registry.**
Resume metadata SHALL live in a **separate file** from the daemon liveness registry (`<root>/run/<mesh>.json`). The liveness registry is pruned on dead-pid detection, which is the exact cold-restart scenario resume needs to survive.

Option chosen: `<root>/run/<mesh>.sessions.json` (or equivalent), owned by `ControlPlane`, written atomically (tmp + rename). The liveness registry's `listLiveRecords()` prune logic is unchanged. Schema: `{meshExpectedAlive: boolean, agents: Record<agentId, {sessionId, cwd, harness, model, mode, effort}>}`.

Rejected alternative: extending the liveness registry. Dead-pid prune would delete resume metadata on cold restart. Changing prune semantics to skip resume-relevant records would conflate two concerns (process liveness vs session identity) in one record.

**D6 — `loadSession` returns the same shape as `newSession`.**
`AcpAgentConnection.loadSession(sessionId, cwd, mcpServers)` SHALL return the same shape as `newSession(mcpServers)` — a session setup result containing `sessionId`, `modes`, `configOptions`, etc. This allows ControlPlane's existing mode/model initialization path to run unchanged after either call. Internally, `loadSession` sends ACP `session/load`, waits for the result, sets `this.sessionId = savedId`, and returns the session setup data.

**D7 — Resumed sessions skip mesh briefing; fresh (or fresh-fallback) sessions inject it.**
The existing `briefed` in-memory `Set<agentId>` is wiped on cold restart, so a resumed agent would incorrectly receive a duplicate mesh briefing on its first prompt. The control plane SHALL track whether the current session was loaded (not new) and skip the briefing injection for loaded sessions. Fresh-fallback from a failed load still injects briefing (the fallback behaves like a normal first start). This is correctness-critical: mesh briefing includes charter, role, and per-agent instructions; injecting the full briefing into a resumed agent's history pollutes the loaded conversation.

**D8 — First-prompt-after-load failure: refresh and retry once.**
When the first prompt sent to a loaded session fails, the control plane SHALL: (1) call `newSession(mcpServers)` to create a fresh session, then (2) re-send the same prompt to the fresh session. This prevents the loss of a human operator prompt or a queued agent mail. The fresh fallback session receives the standard mesh briefing before the retried prompt.

## Risks / Trade-offs

- **External coupling to CLI session stores** → if a CLI prunes/rotates sessions or changes its on-disk format, resume breaks. Mitigation: best-effort with fresh fallback; never block startup on resume; surface a non-fatal event. Record a note that resume depends on `~/.codex`, `~/.claude`, `~/.kimi-code`, opencode db being intact.
- **cwd/worktree path instability** → silent fall-back to fresh. Mitigation: document worktree-path stability as a resume precondition; consider logging when a saved cwd no longer matches.
- **opencode default model is quota-prone** → first prompt after load can 429 even though resume itself works. Mitigation: persist and restore the model (via `session/set_model`); the first-prompt-failure fallback path catches the residual case.
- **Stale/mismatched session after long gap** → resumed agent believes its last actions' results, but the world (git/files/mailbox) may have moved. Mitigation: this is inherent to faithful resume; the agent operates on durable state as truth and verifies before redoing side-effecting actions. No replay of in-flight actions (per spec).
- **meshExpectedAlive state-machine gaps** → a crash misclassified as deliberate stop (no resume) or vice versa (zombie resurrection). Mitigation: enumerate all transitions explicitly in tests; `stop()` path must carry a `reason` to distinguish explicit from crash.
- **Combined `stop()` path** → MeshHostDaemon.stop() currently serves explicit stop, SIGTERM, idle lease, and parent stop. Without a reason parameter, the flag could be cleared for a crash. Mitigation: thread a stop reason through the stop path so meshExpectedAlive is only cleared for explicit/idle-lease reasons, not crash.

## Migration Plan

- Additive only: new sessions file, new fields. Agent records without the file behave as "no saved session" → fresh `session/new` (today's behavior).
- Rollout: land behind normal feature-branch flow; verify on DEV via a kill-and-resume e2e. No data migration needed.
- Rollback: removing the load path reverts to always-fresh; the session file is ignored and harmless.

## Open Questions

- Should a saved-cwd mismatch be surfaced to the operator (UI hint) or silently fall back? Leaning silent + log for MVP.
- Do we expose resume status (resumed vs fresh) per agent in the web console? Nice-to-have, not required for MVP correctness.
