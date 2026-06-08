## ADDED Requirements

### Requirement: Persist agent session identity

The control plane SHALL persist, per agent, the ACP `sessionId` and the `cwd` it was created in, alongside harness, model, mode, and effort. The file SHALL also carry a mesh-level `meshExpectedAlive` flag. The record SHALL live in a file independent of the daemon liveness registry (`<root>/run/<mesh>.json`) — specifically `<root>/run/<mesh>.sessions.json` or equivalent — so that dead-pid pruning by the liveness registry does not destroy resume metadata on cold restart. The record SHALL be written atomically (tmp + rename) and SHALL NOT contain transcript content, permission tokens, credentials, or raw tool output.

#### Scenario: Session id captured on new session

- **WHEN** an agent is started and `session/new` returns a `sessionId`
- **THEN** the control plane persists that `sessionId` together with the agent's `cwd`, harness, model, mode, and effort to the sessions file

#### Scenario: Atomic write

- **WHEN** a per-agent session record is persisted
- **THEN** it is written via a temp file and atomic rename so a crash mid-write cannot corrupt the existing record

#### Scenario: No sensitive content persisted

- **WHEN** a per-agent session record is written
- **THEN** it contains only structured identity/config fields (sessionId, cwd, harness, model, mode, effort per-agent; meshExpectedAlive at mesh level) and never transcript text, permission tokens, or tool output

#### Scenario: Resume metadata survives daemon liveness pruning

- **WHEN** the daemon liveness registry prunes dead-pid entries during a cold restart
- **THEN** the sessions file is untouched and its per-agent resume metadata remains intact

### Requirement: Restore session via session/load when supported

On agent (re)spawn the control plane SHALL call ACP `session/load(sessionId, cwd, mcpServers)` instead of `session/new` if and only if the harness advertised `loadSession: true` in its `initialize` response AND a saved `sessionId` exists for that agent. The `cwd` passed to `session/load` SHALL be the persisted `cwd` from session creation, because `cwd` is part of session identity for the underlying CLI session stores. `loadSession` SHALL return the same shape as `newSession` (a session setup result containing `sessionId`, `modes`, `configOptions`, etc.) so that the caller's mode/model initialization path operates identically after either call.

#### Scenario: Resume a supported harness

- **WHEN** an agent whose harness advertises `loadSession` is respawned and a saved sessionId and cwd exist
- **THEN** the control plane calls `session/load` with that sessionId and the original cwd, and the agent's prior conversation is restored

#### Scenario: loadSession returns same result shape as newSession

- **WHEN** the control plane receives the result from `session/load`
- **THEN** the result has the same shape as a `session/new` result (including modes, configOptions, models), so downstream mode/model handling is unchanged

#### Scenario: Harness does not advertise loadSession

- **WHEN** an agent is spawned whose harness does NOT advertise `loadSession`
- **THEN** the control plane calls `session/new` and does not attempt `session/load`

#### Scenario: No saved session id

- **WHEN** an agent is spawned for the first time, with no persisted sessionId
- **THEN** the control plane calls `session/new`

### Requirement: Deterministic fresh-start fallback on resume failure

The control plane SHALL fall back to `session/new` whenever resume cannot be completed: when `session/load` returns an error (e.g. `resourceNotFound` for a missing underlying session file) OR when the first prompt issued after a successful `session/load` fails. When falling back from a failed first prompt, the control plane SHALL retry the same prompt once against the fresh session (so the triggering prompt — human operator message or agent mail — is not lost).

#### Scenario: session/load errors

- **WHEN** `session/load` returns an error such as `resourceNotFound`
- **THEN** the control plane starts the agent with a fresh `session/new` and the agent continues without prior context

#### Scenario: First prompt after load fails

- **WHEN** `session/load` succeeds but the first prompt sent to the loaded session fails
- **THEN** the control plane creates a fresh `session/new`, then re-sends the same prompt to the fresh session

#### Scenario: Resume never blocks startup

- **WHEN** any step of the resume attempt fails for any reason
- **THEN** the agent still reaches a usable started state via fresh session and the failure is surfaced as a non-fatal log/event

### Requirement: Resumed sessions skip mesh briefing

When an agent session is restored via `session/load`, the control plane SHALL NOT inject the mesh briefing (charter, role, per-agent instructions) into the agent's first prompt. The briefing SHALL only be injected for agents started with a fresh `session/new` — including fresh-fallback sessions after a failed load. This prevents a loaded conversation from being polluted with injected system-level text that was already part of the original session.

#### Scenario: Loaded session does not receive briefing

- **WHEN** an agent's session is restored via `session/load` and the first prompt is composed
- **THEN** the mesh briefing is NOT prepended to that prompt

#### Scenario: Fresh session receives briefing

- **WHEN** an agent starts via `session/new` (including after a failed load fallback)
- **THEN** the mesh briefing IS prepended to its first prompt as today

### Requirement: Auto-respawn respects kill intent

The control plane SHALL auto-respawn all configured agents on daemon start if and only if a mesh-level `meshExpectedAlive` flag is true. When the user deliberately stops the mesh or the mesh is reaped by idle-lease expiry, `meshExpectedAlive` SHALL be cleared to false, and no agents SHALL be auto-respawned on the next daemon start. The flag SHALL be left unchanged on crash, cold restart, and hot restart. State transitions SHALL be enumerated deterministically for all lifecycle paths.

#### Scenario: Crash or cold restart resurrects

- **WHEN** the daemon dies via crash or cold restart while `meshExpectedAlive` is true
- **THEN** on the next start all configured agents are auto-respawned and resumed (subject to harness capability)

#### Scenario: Deliberate mesh stop does not resurrect

- **WHEN** the user deliberately stops the mesh (`meshExpectedAlive` set to false)
- **THEN** no agents are auto-respawned on a subsequent daemon start

#### Scenario: Idle-lease expiry does not resurrect

- **WHEN** a mesh is reaped due to idle-lease expiry (`meshExpectedAlive` set to false)
- **THEN** no agents are auto-respawned on a subsequent daemon start

### Requirement: Prompting a stopped agent starts it fresh

When agents are not auto-respawned (e.g. after a deliberate mesh stop), the control plane SHALL NOT return an error for prompt/wake/steer requests targeting a dead agent. Instead, explicitly engaging a stopped agent SHALL implicitly start it with a fresh `session/new` (no resume, since it was deliberately stopped) and set `meshExpectedAlive` to true. This treats the prompt as an explicit resurrection intent, distinct from auto-respawn.

#### Scenario: Prompt to dead agent starts it fresh

- **WHEN** an operator or agent sends a prompt/wake to an agent that was not auto-respawned
- **THEN** the control plane spawns that agent with a fresh `session/new`, sets `meshExpectedAlive = true`, and delivers the prompt normally

### Requirement: Resume restores conversation only, not execution state

Resume SHALL restore the agent's conversation context only. In-flight execution state — interrupted or incomplete tool calls, long-running commands, and pending ACP permission requests — SHALL be treated as lost and SHALL NOT be replayed or reconstructed.

#### Scenario: In-flight tool call is not replayed

- **WHEN** an agent is resumed after being killed mid tool call
- **THEN** the incomplete tool call is not re-executed automatically and the resumed agent proceeds from conversation state, verifying real state (git/worktree/mailbox) before redoing side-effecting actions
