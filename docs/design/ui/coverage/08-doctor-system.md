# 08 · Doctor / system health + ps diagnostics — coverage

**Scope / routes.** System health & diagnostics: running mesh-host daemons (`mesh ps`),
doctor checks (orphans, sockets, harness availability, service liveness), app/build
version. Read-first with a few recovery actions. `/doctor` (in 管理▾).
**Desktop/mobile.** Desktop: daemon table + doctor findings + recovery. Mobile:
read-only health summary (backend alive? daemons? findings chips); recovery deferred to
desktop/CLI (△).
**Exists vs net-new.** [E] — doctor checks + ps diagnostics ship; [N] redesigned `/doctor`
surface + any in-UI recovery actions ([N] where not already wired).
**Sources read.** `../interaction/08-doctor-system.md`; repo: `store.ts` `fetchDoctor`
`/api/diagnostics/doctor` (structured, secret-free, device-auth gated), `mesh ps` CLI
(`cli-dispatch.ts` `ps`), daemon/orphan detection.

## Function / control / action checklist
- **Read daemon list + health** [E] — mesh, pid, status, uptime (`mesh ps`).
- **Run doctor** [E] — `fetchDoctor`; findings as ok/warn/bad chips.
- **Recovery (where safe): reap orphan / restart daemon** [N] — UI action ([E] underlying via CLI; [N] in-web button).
- **Copy diagnostics** [E] — secret-free payload.
- **App/build version** [E].

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable
(No meaningful **empty** for findings — there is always a health result → N/A.)

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Daemon list/health [E] | ✓(no daemons→"none running") | ✓(ps→spinner) | ✓(table) | ✓(probe failed+retry) | N/A | N/A | ✓("service down" prominent) | ✓(N daemons) | ✓(table) | △(read-only summary) |
| Run doctor [E] | N/A | ✓(running) | ✓(findings chips) | ✓(error+retry) | N/A | ✓(in flight) | ✓(service-down state) | ✓(many findings) | ✓ | ✓(read) |
| Recovery (reap/restart) [N] | N/A | N/A | ✓(when applicable) | ✓(fail+retry) | △(operator only) | ✓(in flight) | △(disabled offline) | ✓(N orphans) | ✓ | △(deferred to desktop/CLI) |
| Copy diagnostics [E] | N/A | N/A | ✓ | ✓ | N/A | N/A | ✓(copies last-known) | ✓(large payload) | ✓ | ✓ |
| App/build version [E] | N/A | ✓ | ✓ | ✓ | N/A | N/A | ✓(cached) | N/A | ✓ | ✓ |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/08-doctor-system.md`;
  `store.ts` `fetchDoctor` `/api/diagnostics/doctor`, `cli-dispatch.ts` `ps`,
  daemon/orphan detection.
