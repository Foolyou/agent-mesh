# Doctor / system health — interaction (Step 1)

Route: `/doctor` (in 管理▾). Inputs: current `SystemPanel` (mesh ps / doctor diagnostics). Invariant: diagnostics must not regress (spec §2).

## Function
System health & diagnostics: running mesh-host daemons (`mesh ps`), doctor checks (orphans, sockets, harness availability, service liveness), and app/build version. Read-first, with a few recovery actions.

## Core user actions
- Read daemon list + health; run doctor; (where safe) reap an orphan / restart a daemon; copy diagnostics; see app version.

## States
- **loading**: running ps/doctor → spinner.
- **populated**: daemon table (mesh, pid, status, uptime) + doctor findings (ok/warn/bad chips).
- **busy**: doctor running / reap-restart action in flight.
- **error**: probe failed → error + retry.
- **offline**: backend unreachable → "service down" prominently (the one surface that must convey this clearly).

## Desktop
```
┌ Doctor / system ────────────────────────────────────────┐
│ app v…   backend ● alive                                  │
│ daemons:  dev-mesh   pid 1446  ● running   2h            │
│ doctor:   ✓ no orphans  ⚠ 1 stale socket  ✓ harnesses ok │
│           [run doctor]  [copy report]                      │
└───────────────────────────────────────────────────────────┘
```

## Mobile
- Read-only health summary (backend alive? daemons? findings as chips). Recovery actions deferred to desktop/CLI.

## Mobile divergence
Diagnostics are read-only on mobile (deep recovery is desktop/CLI). (spec §1.7)

## Open questions
None.

## Change / review log
- 2026-06-20 — created (Step 1).
