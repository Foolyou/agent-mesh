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
- 2026-06-21 — Phase B Step 2 mockup (`UiMockup.tsx`): the device-auth pre-auth gate built in
  the guarded `/__ui-mockup` (`?surface=device-auth`) — a single full-screen centered card
  (identical desktop/mobile, large tap targets). Shows the device code prominently + the
  host-CLI approve instruction (`mesh approve <code>`, authoritative) + a poll/"等待批准"
  status; a divider; a one-time bootstrap-token field + self-approve submit (body-only — note
  "不写入 URL、不持久化"); the remembered deep link to return to after approval; and a security
  footer ("唯一放行路径 = 已批准的设备令牌；loopback 不受信；/api/* 始终门禁"). States:
  loading→requesting code, permission→pending base (poll), error→generic expired/rejected +
  refresh-for-new-code (non-leaky), busy→submitting/resolving target, offline→"服务不可用"
  (≠ not approved) + bootstrap disabled, boundary→prominent/long code + long token field +
  long remembered route. empty/populated → explicit N/A explanation (no accidental app frame).
  Aligns with device-auth/P1: approved device token only allow path, loopback not trusted,
  host-CLI approve authoritative, bootstrap body-only, revoked/unknown/expired generic. No
  additional [E] capability beyond the checklist found. Index (`?index=1`) gains the 12 row.
  Fixture-only, true C5–C8, v2 tokens.
- 2026-06-22 — Step 7.4-A.2b-ii `/bnw` device-auth gate real wiring (`src/web/client/bnw/device-auth-gate.tsx` BnwBoot, replacing the shared Boot for the `/bnw` prefix in index.tsx; the old Boot/root UI are untouched). Reuses the shared device-auth data layer (bootAuthorized / runEnrollment / submitBootstrap). Security invariants preserved (display/flow migration, not a relaxation): approved device token = sole allow path (probe gated `/api/state`); bootstrap token body-only, never persisted/URL; fail-closed generic errors; `?next` open-redirect-guarded to same-origin `/bnw` targets only (non-/bnw next rejected). Flagged deviation from mockup 12: the approve instruction uses the REAL CLI `mesh device approve <code>` (the mockup wrote `mesh approve <code>`).
