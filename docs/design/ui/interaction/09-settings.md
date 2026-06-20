# Settings — interaction (Step 1)

Route: `/settings` (the topbar `设置▾`). Inputs: phase1 §2 (theme/lang/auth folded into 设置▾), device-auth work.

## Function
App preferences and access: theme (mode × accent), language, default-view preference, and device authorization management (approved/pending/revoked devices, bootstrap).

## Core user actions
- Pick theme mode (Dark·Slate / Light·Cool / Eye-care·Warm) + accent (Teal / Ember / Azure); edit custom palette; switch language; set default landing view (runtime/board); manage devices (approve/revoke, see this device); mint bootstrap token (host-side echo).

## States
- **loading**: fetching device list → skeleton.
- **populated**: settings groups rendered; current theme/lang/default reflected.
- **busy**: device approve/revoke or palette save in flight.
- **error**: action failed → inline error.

## Desktop
```
┌ Settings ───────────────────────────────────────────────┐
│ Appearance:  mode [Dark|Light|Eye-care]  accent [Teal|Ember|Azure]
│              custom palette… (advanced)                    │
│ Language:    [中文 | English]                              │
│ Default view: [运行态 | 看板]                              │
│ Devices:     this device ● approved                        │
│              pending: K7Q-3F9  [approve][revoke]           │
│              approved: chrome-laptop  [revoke]             │
└───────────────────────────────────────────────────────────┘
```
- Theme switch is instant (runtime CSS-var swap); AA enforced by tokens (Step 3).

## Mobile
- Same groups, stacked; appearance + language + default-view fully usable; device management read + approve/revoke. Reached via 更多 → 设置.

## Mobile divergence
Custom-palette advanced editor simplified on mobile; core theme/lang/default + device approve/revoke fully supported.

## Open questions
- Does device "approve" belong here vs host-CLI only? Per device-auth design, host CLI is authoritative; the WebUI settings surface is for already-authorized operators to review/revoke + read pending. (No blocking gap; flagged for prdmgr at gate.)

## Change / review log
- 2026-06-20 — created (Step 1).

## Components used (Step 2)
Parts on this page map to shared components in `../components/` (reuse matrix: `../components/00-inventory.md`). Canonical mappings: status surfaces → StatusChip; rows/cards → StatusListRow; framed surfaces → PanelFrame; section/view switches → SegmentedControl; empty/error/loading → EmptyState / ErrorBanner / Skeleton; navigation → RouteLink; inline approve/deny → ApprovalCard; conversation → TranscriptItem family + Composer.

## Change / review log — Step 2 addendum
- 2026-06-20 — Step 2 back-consistency: this page's one-off parts unified to shared components (StatusListRow / PanelFrame / SegmentedControl / ApprovalCard / Composer / EmptyState / ErrorBanner). See `../components/00-inventory.md` "Backward-consistency findings".
