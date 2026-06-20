# Harnesses — interaction (Step 1)

Route: `/harnesses` (in 管理▾). Inputs: current `HarnessPanel`; harness-upgrade-ui work (dual version + restart-old-version).

## Function
Manage harness adapters (claude/codex/opencode/kimi): see install/auth status + **dual version (adapter · body tool)**, install/update/reprobe, and restart agents still running an old adapter version.

## Core user actions
- View per-harness rows (status chip, `adapter X · tool Y` versions, auth, path); install/update (npm) or copy self-install command; reprobe; restart old-version agents (after-idle / force).

## States
- **loading**: probing → "loading status" rows.
- **populated**: rows with status badge (`installed vX` / `update available — vX→vY` / `missing` / `version comparison unavailable`) + dual-version line.
- **busy**: install streaming (live progress log) / reprobe in flight.
- **error**: probe error / install failed → row error + retry; registry-unavailable → "comparison unavailable" (non-blocking).
- **offline**: last-known rows; actions disabled.
(no meaningful "empty" — the harness set is fixed.)

## Desktop
```
┌ Harnesses ──────────────────────────────────────────────────────────┐
│ Claude   ● installed v0.47.0                                          │
│   claude-agent-acp 0.47.0 · claude 2.1.181        [reprobe] [update]  │
│ Codex    ⚠ update available — v0.15→v0.16                             │
│   codex-acp 0.16.0 · codex 0.141.0                [reprobe] [update]  │
│   running an older codex — restart to adopt:                          │
│     demo/codex-1   [Restart agent] [force]                            │
│ OpenCode ○ missing — install required    [copy command][docs][reprobe]│
└──────────────────────────────────────────────────────────────────────┘
```

## Mobile
- Stacked harness cards (status + dual version); reprobe + install/update buttons; install progress in a sheet. Old-version restart list per card.

## Mobile divergence
Read + reprobe + update fully supported; verbose install logs collapse into an expandable sheet. (spec §1.7 — management simplified, not removed.)

## Open questions
None.

## Change / review log
- 2026-06-20 — created (Step 1).
