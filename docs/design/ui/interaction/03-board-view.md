# Board view (C) — interaction (Step 1)

Routes: `/mesh/<m>/board` (+ `/mesh/<m>/board/task/<id>` deep link, phase 3). Inputs: ui-redesign.md §1.6, phase1.md §3.2.

## Function
The project/task view for a mesh, promoted from a cramped rail tab to a full peer view: list / detail / kanban of epics→tasks→subtasks, a router dispatch station, and automatic status reflow from agent lifecycle. Peer to runtime via the view switcher; future "C as primary" = just changing the default-view preference.

## Core user actions
- Browse tasks (list / kanban); filter by status/label/assignee; open a task → detail.
- In detail: read description/comments/lifecycle, reassign, set status/labels, comment, dispatch to an agent.
- Router "dispatch station": hand a task to an agent (creates the mail/turn).

## States
- **empty**: no tasks → empty state with "create epic/task" CTA (or "dispatch from runtime").
- **loading**: board fetch → skeleton columns/rows.
- **populated**: tasks rendered; status chips per task (`idle`/`working`/`blocked`/`done`).
- **busy**: a status/assignee/dispatch mutation in flight → optimistic update + spinner; CAS-conflict → reconcile note.
- **error**: load/mutation failed → inline error + retry.
- **offline**: last-known board + "reconnecting"; mutations disabled.

## Desktop
```
┌ board ──────────────────────────────────────────────────────────────────┐
│ [list | kanban]   filter: status▾ label▾ assignee▾        [+ Epic][+ Task]│
├──────────────────────────────────────────────────────────────────────────┤
│ list:  ▸ Epic A                                                            │
│          □ task-1  ● ready   @codex-1   #infra    [dispatch▾]              │
│          □ task-2  ▶ working @opencode-1 #ui                               │
│        ▸ Epic B …                                                          │
│ kanban:  [idle] [working] [blocked] [done]  ← drag between columns        │
└──────────────────────────────────────────────────────────────────────────┘
   click task → detail (right context pane or /board/task/<id>)
```
- list + kanban toggle; kanban drag = desktop. Dispatch station = per-task `dispatch▾` (assign to agent) + an epic-level dispatcher.
- Task detail opens in the right context pane (or full route on deep link).

## Mobile
```
┌ board (list) ───────────────┐   tap →  ┌ task detail ──────────┐
│ filter: status▾              │ ──────▶  │ task-1  ▶ working      │
│ ▸ Epic A                     │          │ @codex-1 #ui           │
│   task-1 ● @codex-1          │          │ desc / comments        │
│   task-2 ▶ @opencode-1       │  ◀ back  │ [status▾][assign▾]     │
└──────────────────────────────┘          └────────────────────────┘
```
- list + detail master-detail; **kanban simplified to a status filter** (no drag).

## Mobile divergence
Kanban drag is desktop-only (touch drag is error-prone); mobile uses list + status filter + tap-to-detail. Bulk/epic management simplified. (spec §1.6/§1.7)

## Open questions
None for Step 1 (board internals are phase 3; this doc fixes the surface + states).

## Change / review log
- 2026-06-20 — created (Step 1).

## Components used (Step 2)
Parts on this page map to shared components in `../components/` (reuse matrix: `../components/00-inventory.md`). Canonical mappings: status surfaces → StatusChip; rows/cards → StatusListRow; framed surfaces → PanelFrame; section/view switches → SegmentedControl; empty/error/loading → EmptyState / ErrorBanner / Skeleton; navigation → RouteLink; inline approve/deny → ApprovalCard; conversation → TranscriptItem family + Composer.

## Change / review log — Step 2 addendum
- 2026-06-20 — Step 2 back-consistency: this page's one-off parts unified to shared components (StatusListRow / PanelFrame / SegmentedControl / ApprovalCard / Composer / EmptyState / ErrorBanner). See `../components/00-inventory.md` "Backward-consistency findings".
