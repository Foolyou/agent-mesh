# Notification center — interaction (Step 1)

Route: `/notifications` (topbar 🔔; 更多 on mobile). Inputs: ui-redesign.md §1.8, toolkit §2.5.

## Function
App-level (cross-mesh) system-message aggregator: harness-upgrade prompts, frontend self-update, connection/service status, system alerts. **Not** transcript, **not** a mesh's local activity/mail. Solves "system notices scattered, transient, no history".

## Core user actions
- See unread count on the 🔔 entry; open the list/drawer; read an item, follow its action (e.g. refresh / open harnesses); mark read; review history.

## States
- **empty**: no notifications → "You're all caught up".
- **loading**: fetching → skeleton list.
- **populated**: list of items (type icon + title + time + read/unread), newest first; unread badge on 🔔.
- **error**: load failed → inline error + retry.
- **offline**: shows the connection-lost item itself; list = last-known.
(Note: server-side persistence/unread model is **phase 4**; Step 1 fixes the surface + entry + states. The 🔔 entry + count is in the phase-1 shell.)

## Desktop
```
🔔3 → drawer ┌ Notifications ──────────────────────────┐
             │ ⚠ Harness codex update available  · 2m  →│
             │ ⟳ Frontend updated — refresh      · 5m  →│
             │ ● Backend reconnected             · 1h   │
             │ [mark all read]            [history ▾]   │
             └──────────────────────────────────────────┘
```
- Right-side drawer from 🔔; high-urgent items (e.g. must-refresh) ALSO keep a lightweight inline banner but are archived here (主从, spec §1.8).

## Mobile
- Full-screen list via 更多 → 通知; same items + mark-read + history.

## Mobile divergence
Drawer → full-screen list; otherwise identical. Core on mobile (status awareness matters on phone).

## Open questions
- Exact membership (which message classes are global vs mesh-local) + unread/read/history data model = phase 4 detail; spec §1.8 sets the boundary. No Step-1 blocker.

## Change / review log
- 2026-06-20 — created (Step 1).
