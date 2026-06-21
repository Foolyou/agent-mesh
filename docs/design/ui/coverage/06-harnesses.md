# 06 · Harnesses — coverage

**Scope / routes.** Manage harness adapters (claude/codex/opencode/kimi): install/auth
status + dual version (adapter · body tool), install/update/reprobe, and restart agents
still running an old adapter version. `/harnesses` (in 管理▾).
**Desktop/mobile.** Desktop: per-harness rows + install progress log. Mobile: stacked
harness cards (status + dual version) + reprobe/install + install progress in a sheet (△ simplified).
**Exists vs net-new.** [E] — entire surface ships (`HarnessPanel.tsx`); [N] redesigned styling only.
**Sources read.** `../interaction/06-harnesses.md`; repo: `HarnessPanel.tsx`
(`harnessVersionLine`, status badges, OldVersionAgents), `store.ts`
`installHarness(id)`→jobId stream, `reprobeHarness(id)`, `harnesses-changed` WS coalesce.

## Function / control / action checklist
- **View per-harness row** [E] — status chip, adapter X · tool Y dual version, auth, path.
- **Install / update (npm)** [E] — or copy self-install command; streamed progress log.
- **Install progress (live log + retry-stream + close)** [E] — `InstallProgress` (running/done/error/interrupted): stream output, retry a dropped stream, dismiss on completion. (audit #26)
- **Self-install guide** [E] — `SelfInstallerGuide`: copy install command, open official docs, "reprobe to detect" (for npm-locked harnesses). (audit #27)
- **Reprobe** [E] — re-run probe.
- **Restart old-version agents (force / after-idle / cancel)** [E] — `OldVersionAgents` `respawnAgent("force"|"after-idle"|"cancel")`: schedule after-idle, force (two-click, loses ACP session), or cancel a pending restart. (audit #28)

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable
(No meaningful **empty** — harness set is fixed → N/A.)

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Per-harness row [E] | N/A | ✓("loading status") | ✓(installed vX / update vX→vY / missing / cmp-unavailable) | ✓(probe error) | N/A | ✓ | ✓(last-known) | ✓(4 harnesses; long path trunc) | ✓ | ✓(card) |
| Install / update [E] | N/A | N/A | ✓ | ✓(install failed+retry; registry-unavailable=non-blocking) | △(host-side action) | ✓(live progress log) | △(disabled offline) | ✓(long log scroll) | ✓ | △(progress sheet) |
| Reprobe [E] | N/A | ✓ | ✓ | ✓(retry) | N/A | ✓(in flight) | △(disabled) | N/A | ✓ | ✓ |
| Restart old-version agents [E] | N/A(none old) | ✓ | ✓(list per harness) | ✓(fail+retry) | △(perm) | ✓(restarting) | △(disabled) | ✓(N old agents) | ✓ | ✓(per card) |
| Install progress log/retry/close [E] (audit #26) | N/A | ✓(streaming) | ✓(done→close) | ✓(interrupted→retry stream) | △(host-side) | ✓(live log) | △(disabled offline) | ✓(long log scroll) | ✓ | △(progress sheet) |
| Self-install guide [E] (audit #27) | N/A | N/A | ✓(copy cmd + docs + reprobe) | ✓(reprobe still missing) | △(host-side) | ✓(reprobing) | △(disabled offline) | N/A | ✓ | ✓ |
| Restart force/after-idle/cancel [E] (audit #28) | N/A(none old) | ✓ | ✓(after-idle/force/cancel) | ✓(fail+retry) | △(perm) | ✓(in flight) | △(disabled offline) | ✓(N old agents) | ✓ | ✓(per card) |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/06-harnesses.md`;
  `HarnessPanel.tsx` (harnessVersionLine/badges/OldVersionAgents), `store.ts`
  installHarness/reprobeHarness, `harnesses-changed` WS.
- 2026-06-21 — backward-consistency completion (audit `14`): +install progress
  retry/close (#26), +self-install guide (#27), +restart force/after-idle/cancel (#28).
  `HarnessPanel.tsx` (`InstallProgress`/`SelfInstallerGuide`/`OldVersionAgents`).
