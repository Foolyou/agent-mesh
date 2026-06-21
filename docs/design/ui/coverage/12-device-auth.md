# 12 · Device-auth (pre-auth gate) — coverage

**Scope / routes.** The unauthorized landing: an unapproved device shows a device code +
polls for approval, or pastes a one-time bootstrap token. The only allow path is an
approved device token (loopback not trusted). Shown for ANY route while unauthorized
(replaces the app until approved); the static shell loads unauthenticated enough to show
THIS page, `/api/*` stays gated.
**Desktop/mobile.** Same single-card flow, full-screen, large tap targets (identical on
both — gate to everything).
**Exists vs net-new.** [E] — device-auth ships (enroll/poll/bootstrap + host-CLI approve);
[N] restyle of the gate page for the redesigned shell.
**Sources read.** `../interaction/12-device-auth.md`; repo: `device-auth.ts`
(`submitBootstrap` `/api/auth/device/bootstrap`, device-code request + poll loop, phase
constants `pending|approved|revoked|unknown`), `auth-store`/`auth-codes` (host),
host-CLI approve, web gate (`server.ts` `authorizeRequest`).

## Function / control / action checklist
- **Read device code** [E] — shown while pending; operator approves via host CLI.
- **Wait / poll status** [E] — polls until approved / lapsed.
- **Paste bootstrap token (self-approve)** [E] — `submitBootstrap`; body-only, never persisted.
- **Retry after expiry** [E] — refresh for a new code.
- **Continue to remembered deep link** [E] — on approval, resolve the originally-requested URL.

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable
(This whole surface IS the **unauthorized** state; **empty/populated** N/A — it's a gate.)

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Read device code [E] | N/A | ✓(requesting code) | N/A | ✓(code expired→"refresh for new") | ✓("waiting for approval"; polls) | N/A | ✓("service unavailable" ≠ "not approved") | ✓(code prominent) | ✓ | ✓(large) |
| Wait / poll [E] | N/A | ✓(polling) | N/A | ✓(lapsed→unknown→prompt refresh) | ✓(pending base state) | N/A | ✓(reconnect) | N/A | ✓ | ✓ |
| Paste bootstrap [E] | N/A | N/A | N/A | ✓(bad/used token→rejected msg) | ✓(self-approve path) | ✓(submitting) | ✓(disabled offline) | ✓(long token field) | ✓ | ✓(field below code) |
| Retry after expiry [E] | N/A | ✓(new code) | N/A | ✓ | ✓ | ✓ | ✓ | N/A | ✓ | ✓ |
| Continue to deep link [E] | N/A | ✓(booting) | N/A(→app) | ✓(boot fail) | N/A(→authorized) | ✓(resolving target) | ✓(retries) | ✓(any remembered route) | ✓ | ✓ |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/12-device-auth.md`;
  `device-auth.ts` (submitBootstrap/poll/phases), `auth-store`/`auth-codes`, host-CLI
  approve, web gate `server.ts` `authorizeRequest`.
