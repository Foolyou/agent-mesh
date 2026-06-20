# Channels (Feishu) — interaction (Step 1)

Route: `/channels` (in 管理▾). Inputs: current `FeishuPanel`; feishu channel + device-auth enrollment work.

## Function
Configure and authorize external channels (Feishu): channel config, bind a chat→mesh, and approve/revoke per-`(channel, openId)` senders (dynamic allowlist + auth-code enrollment).

## Core user actions
- View channel status (configured/disabled); bind a chat to a mesh; review pending sender auth-codes → approve/revoke; revoke an authorized sender.

## States
- **empty**: no channel configured → "Feishu not configured" + setup hint (config lives on disk; UI shows status).
- **loading**: fetching channel/registry → skeleton.
- **populated**: channel rows + binding list + sender registry (approved/revoked).
- **permission**: pending sender registration(s) → approve/revoke cards (the dynamic-authz inbox).
- **busy**: approve/revoke/bind in flight.
- **error**: config invalid / action failed → inline error.

## Desktop
```
┌ Channels ───────────────────────────────────────────────┐
│ Feishu  ● configured (appId …)                            │
│ bindings:  chat:oc_… → dev-mesh        [rebind][unbind]   │
│ pending senders:  open_…  (channel feishu:app)  [approve][revoke]
│ authorized:       open_…  → revoke                         │
└───────────────────────────────────────────────────────────┘
```

## Mobile
- Read-only status + the pending-sender approve/revoke inbox (the actionable part). Binding/config simplified or deferred to desktop.

## Mobile divergence
Channel setup/binding is desktop-oriented; mobile surfaces status + sender approvals (low-effort, high-value). (spec §1.7)

## Open questions
None for Step 1 (channel config internals out of scope; surface + states fixed).

## Change / review log
- 2026-06-20 — created (Step 1).
