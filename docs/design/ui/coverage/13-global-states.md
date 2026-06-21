# 13 · Global states (login / connection / offline / error / 404) — coverage

**Scope.** Cross-cutting states that aren't a single surface: initial boot/connection,
WS connect/reconnect, gate 401 → device-auth, SPA 404 → fallback, and the unified
offline/error treatment every surface inherits. Aggregated here so no surface invents
its own; per-surface matrices reference these.
**Desktop/mobile.** Same semantics on both; presentation differs only by layout
(banner/overlay desktop; full-screen/sheet mobile).
**Exists vs net-new.** [E] — connection/reconnect, gate 401, SPA 404, boot probe ship;
[N] — the *unified* offline/error visual treatment (consistent banner/chip + retry
contract) applied across all surfaces.
**Sources read.** Repo: `server.ts` (SPA catch-all + 404; `authorizeRequest` 401 gate;
WS upgrade), `store.ts` (WS open/close/reconnect, snapshot-first, request `guard`
error wrapping), `device-auth.ts` (boot probe → 200 app / 401 gate), `index.tsx` boot.

## Function / control / action checklist
- **Boot / connection probe** [E] — boot probe decides app vs device-auth gate.
- **WS connect / snapshot-first** [E] — first frame is snapshot; then live deltas.
- **Reconnect on drop** [E] — offline → last-known + "reconnecting"; resumes on restore.
- **Gate 401 → device-auth** [E] — any gated `/api`/`/ws` 401 routes to the gate (`12`).
- **SPA 404 / unknown route** [E] — catch-all fallback (after `/api`,`/ws`); unknown in-app route → not-found within shell.
- **Unified error + retry contract** [N] — ErrorBanner + retry, consistent across surfaces.
- **Offline contract** [N] — disable mutations, show last-known, reconnecting affordance.

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable
(Columns here describe how the GLOBAL behavior manifests; `populated` = normal/connected.)

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Boot / connection probe [E] | N/A | ✓(probing) | ✓(app booted) | ✓(boot fail→retry) | ✓(401→device-auth) | ✓(resolving) | ✓(service unavailable) | N/A | ✓ | ✓(full-screen) |
| WS connect / snapshot-first [E] | ✓(no data yet) | ✓(awaiting snapshot) | ✓(live) | ✓(snapshot fail) | △(unauth→gate) | N/A | ✓(drop→reconnect) | ✓(large snapshot) | ✓ | ✓ |
| Reconnect on drop [E] | N/A | ✓(reconnecting) | ✓(restored) | ✓(repeated fail backoff) | N/A | N/A | ✓(the core state) | ✓(long outage) | ✓(thin banner) | ✓(banner/sheet) |
| Gate 401 → device-auth [E] | N/A | ✓ | N/A(→authorized) | ✓ | ✓(the redirect) | N/A | ✓ | N/A | ✓ | ✓ |
| SPA 404 / unknown route [E] | ✓(not-found view) | ✓ | N/A | ✓(server 404→fallback) | N/A | N/A | ✓(cached shell) | ✓(deep bad path) | ✓ | ✓ |
| Unified error + retry [N] | N/A | N/A | N/A | ✓(ErrorBanner+retry everywhere) | △(permission reason variant) | ✓(retrying) | ✓(offline variant) | ✓(long error text) | ✓ | ✓ |
| Offline contract [N] | ✓(no last-known) | ✓ | N/A | ✓ | N/A | △(mutations disabled) | ✓(last-known + reconnecting) | ✓(stale large data) | ✓ | ✓ |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `server.ts` (SPA 404 + 401 gate + WS),
  `store.ts` (WS lifecycle + snapshot-first + guard errors), `device-auth.ts` (boot probe),
  `index.tsx` boot. p2p-DM connection states fold here per lead #683 assumption 4.
