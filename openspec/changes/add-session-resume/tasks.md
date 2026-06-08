## 1. Capability detection

- [ ] 1.1 In the ACP client, capture `loadSession` from each adapter's `initialize` response and expose it on the connection (e.g. `conn.supportsLoadSession`).
- [ ] 1.2 Add a unit test asserting the flag is parsed true/false correctly from representative `initialize` payloads (codex/claude/kimi/opencode true; a synthetic false case).

## 2. Session storage and identity capture

- [ ] 2.1 Create a session storage module that reads/writes `<root>/run/<mesh>.sessions.json` (or equivalent path) atomically (tmp + rename). File mode 0600; parent run/ directory 0700. Schema: `{meshExpectedAlive: boolean, agents: Record<agentId, {sessionId, cwd, harness, model, mode, effort}>}`.
- [ ] 2.2 Ensure the sessions file is independent of the daemon liveness registry (`<root>/run/<mesh>.json`); dead-pid pruning in `listLiveRecords()` must NOT touch the sessions file.
- [ ] 2.3 Test: sessions file survives a cold restart (simulated dead-pid prune leaves session data intact).
- [ ] 2.4 Capture `sessionId` and the `cwd` used at session creation on the connection; persist them to the sessions store per-agent when a new session is created.
- [ ] 2.5 Ensure the stored record never includes transcript text, permission tokens, or tool output (assert in a test).
- [ ] 2.6 Test: a fresh `session/new` persists `{sessionId, cwd, harness, model, mode, effort}` per-agent; `meshExpectedAlive` defaults to true on first write. Old agent records without the new fields load as "no saved session".

## 3. Resume on spawn

- [ ] 3.1 Add a `loadSession(sessionId, cwd, mcpServers)` method to the ACP client that wraps ACP `session/load`, sets `this.sessionId = savedId`, and returns a result with the same shape as `newSession` (modes, configOptions, models, etc.).
- [ ] 3.2 In the control-plane spawn path, select session setup: call `loadSession` when `supportsLoadSession && savedId`, otherwise `newSession`. The downstream mode/model handling runs against the returned session setup result identically regardless of which path was taken.
- [ ] 3.3 Implement fresh-start fallback: on `session/load` error (e.g. `resourceNotFound`), call `newSession` and proceed.
- [ ] 3.4 Implement first-prompt-after-load fallback: when the first prompt sent to a loaded session fails, call `newSession(mcpServers)`, then re-send the same prompt once to the fresh session. Track this state with a per-agent `resumePendingValidation` flag (or equivalent) that is cleared after the first successful prompt or after fallback.
- [ ] 3.5 Tests: resume-supported path loads; no-capability path uses new; no-saved-id path uses new; load-error path falls back; first-prompt-failure path falls back and retries the prompt.

## 4. Resumed session briefing

- [ ] 4.1 Track whether the current session was loaded (not new) at the control-plane level.
- [ ] 4.2 In `compose()` / briefing injection: skip the mesh briefing for loaded sessions; inject it for fresh sessions and fresh-fallback sessions.
- [ ] 4.3 Test: a resumed agent's first prompt does NOT contain the mesh charter/role/instructions; a fresh-started agent's does; a fresh-fallback-after-load-failure agent's does.

## 5. Kill-intent-respecting auto-respawn

- [ ] 5.1 Define the `meshExpectedAlive` state machine: set true on daemon reachable; set false on deliberate mesh stop and on idle-lease expiry; leave unchanged on crash, cold restart, and hot restart.
- [ ] 5.2 Thread a stop `reason` through `MeshHostDaemon.stop()` / `ControlPlane.stop()` so the flag is only cleared for explicit/idle-lease reasons, never for crash.
- [ ] 5.3 On daemon start / `ControlPlane.start()`, read the sessions file: if `meshExpectedAlive` is true, auto-respawn all configured agents (attempting resume per harness). If false, skip all agents — set their status to `dead` in the UI snapshot.
- [ ] 5.4 Prompt/wake/steer targeting a skipped (dead) agent must implicitly start it with a fresh `session/new`, set `meshExpectedAlive = true`, and deliver the prompt — never return an error.
- [ ] 5.5 Tests: ready sets true; deliberate mesh stop sets false (not resurrected on daemon restart); idle-lease stop sets false (not resurrected on daemon restart); crash leaves true (resurrected); cold restart leaves true (resurrected); warm restart does not affect flag; explicit prompt to dead agent spawns it fresh and sets meshExpectedAlive true.

## 6. End-to-end verification

- [ ] 6.1 Add a Playwright/integration e2e: start a mesh on a temp DEV instance, send a prompt establishing a sentinel fact, `kill -9` the agent/daemon, restart, assert the resumed agent recalls the sentinel.
- [ ] 6.2 Negative assertion in the same e2e: no duplicate side-effects after resume (e.g. sentinel-tagged commit count == 1, no repeated mail).
- [ ] 6.3 Assert deliberate mesh stop is not auto-resurrected on daemon restart in the e2e.
- [ ] 6.4 End-to-end resume-after-stop: deliberately stop the mesh, daemon restart does NOT auto-spawn agents, then send a prompt to a stopped agent — assert it fresh-starts, receives the prompt, and `meshExpectedAlive` becomes true.

## 7. Gates and docs

- [ ] 7.1 `bunx tsc --noEmit` clean; `bun test` green; relevant `*.e2e.ts` updated and passing on DEV.
- [ ] 7.2 Note resume's external coupling (CLI session stores) and the worktree-path-stability precondition in docs/dev-workflow.md.
- [ ] 7.3 All four harnesses (codex, claude, kimi, opencode) are in the verified list; note that opencode's default model can 429 so model restore + first-prompt fallback remain mandatory.
