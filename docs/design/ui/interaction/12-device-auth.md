# Device-auth (pre-auth gate) — interaction (Step 1)

Route: shown for ANY route while the device is unauthorized (replaces the app until approved). Inputs: device-auth design + operations docs. Invariant: must not regress (spec §2).

## Function
The unauthorized landing: an unapproved device sees a device code + polls for approval, or pastes a one-time bootstrap token. The only allow path is an approved device token (loopback not trusted). Static shell loads unauthenticated enough to show THIS page; `/api/*` stays gated.

## Core user actions
- Read the device code; wait while polling; OR paste a bootstrap token to self-approve; retry after expiry; (after approval) continue to the originally-requested deep link.

## States
- **loading**: requesting a device code / polling status.
- **permission**: showing code + "waiting for approval" (operator approves via host CLI); polls.
- **busy**: submitting bootstrap token.
- **error**: code expired → "refresh for a new code"; bad/used bootstrap token → rejected message.
- **unauthorized**: the base state (this whole page).
- **offline**: backend unreachable → "service unavailable" (distinct from "not approved").
- **(success)**: approved → app boots and resolves the remembered target URL (deep-link preserved through auth).

## Desktop
```
┌ Authorize this device ───────────────────────────────────┐
│ Device code:  K7Q-3F9     (waiting for approval…)         │
│ On the host:  mesh device approve K7Q-3F9                 │
│ ── or ──                                                  │
│ Bootstrap token: [____________]   [Submit]               │
│ (code expires in 10:00)                                   │
└───────────────────────────────────────────────────────────┘
```

## Mobile
- Same single-card flow, full-screen, large tap targets; code prominent; bootstrap field below.

## Mobile divergence
None — identical flow, full-screen. Core on both (gate to everything).

## Open questions
None (behavior fixed by the shipped device-auth design; this doc records the UI surface/states for the redesigned shell).

## Change / review log
- 2026-06-20 — created (Step 1).
