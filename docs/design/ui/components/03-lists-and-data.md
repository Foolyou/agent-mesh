# Step 2 components — 03 Lists & data

## StatusListRow (the big unification)
- **Purpose**: the shared row primitive = `[leading StatusChip] title [meta…] [trailing ActionBar]`. One component, many variants — replaces the separate "mesh row / agent card / task row / harness row / device row / channel row / notification item" one-offs from Step 1.
- **Variants** (data differs, structure identical):
  - **mesh-row** (left nav): chip + mesh name + agent count → RouteLink `/mesh/<m>`.
  - **agent-card** (mobile runtime): chip + agent id + activity + pending-approval Badge → focus.
  - **task-row** (board): chip + task title + assignee + labels + `dispatch▾`.
  - **harness-row**: chip + label + VersionLine + auth + install/reprobe actions.
  - **device-row** (settings): chip + device label + last-seen + revoke.
  - **channel-row / sender-row**: chip + identity + bind/approve/revoke.
  - **notification-item**: type icon + title + time + read/unread.
- **States**: default/hover/selected(current route)/disabled; density compact (mobile).
- **Desktop/mobile**: desktop = inline row; mobile = taller card with wrapped meta + bigger tap target (same component, responsive).
- **Reuse**: composes StatusChip + RouteLink + Badge + ActionBar. **Step-1 fix**: runtime(agent card), board(task row), harness, settings(device), channels(rows), notifications, shell(mesh row) docs back-edited to say "StatusListRow variant".

## FilterBar
- **Purpose**: filter a list by facets.
- **Variants**: dropdown facets (status/label/assignee), search box; active-filter chips.
- **Surfaces**: board, notifications (type/read filter). **Reuse**: Select + StatusChip(active filters).

## EmptyState
- **Purpose**: a list/page with no content → icon + one-line explanation + primary CTA (invitation to act, not mood).
- **Variants**: with/without CTA; per surface copy.
- **Surfaces**: shell(no meshes), runtime(stopped), board(no tasks), assistant(no convo), channels(not configured), notifications(caught up), new-mesh(blank).
- **Step-1 fix**: each page's "empty" state now references this shared component.

## ErrorBanner / Offline banner
- **Purpose**: inline, in-context error/connection feedback (explain what happened + how to fix; never just mood). Includes the must-refresh frontend-update banner (主从 with notification center).
- **Variants**: error(bad) / warn / info / offline(reconnecting); dismissible vs sticky; with retry action.
- **Surfaces**: every page's error/offline state + shell reconnect + upgrade banner.
- **Step-1 fix**: page "error"/"offline" states unified to this.

## StatTile / metric
- **Purpose**: a small labeled value (app version, uptime, counts) in doctor/overview.
- **Surfaces**: doctor, (future) overview. **Reuse**: PanelFrame + text.

## VersionLine (adapter · body)
- **Purpose**: compact dual-version line `codex-acp 0.16.0 · codex 0.141.0` (single command for tool-direct harnesses; `—` unknown). From the shipped harness-upgrade work.
- **Surfaces**: harness-row only. **Reuse**: text + tokens; sits in StatusListRow(harness variant).

## Change / review log
- 2026-06-20 — created (Step 2). StatusListRow + EmptyState + ErrorBanner unifications back-applied to Step 1.
