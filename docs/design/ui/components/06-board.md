# Step 2 components — 06 Board (GitHub-Issues depth)

Board is the highest-part-count surface (deepened to GitHub-Issues maturity, see `../interaction/03-board-view.md`). Board-specific parts below; shared parts (StatusChip, PanelFrame, SegmentedControl, FilterBar, EmptyState/ErrorBanner/Skeleton, ApprovalCard, RouteLink, Composer) are reused from `01`–`04`, not redefined.

> **Correction (2026-06-20, prdmgr/user):** GitHub *Milestones* was a maturity benchmark, not a feature. No milestone components, no `BoardMilestone` entity. All parts below map to the **existing** data model (Epic → Task → Subtask, labels, assignees, lifecycle, comments, priority, deps). **Epic is the grouping/aggregation primitive.**

## IssueListRow
- **Purpose**: one issue in the list — `#N · lifecycle StatusChip · title · AssigneeAvatar · LabelChips · priority · subtask progress · blocked Badge · updated-at`. A **StatusListRow variant** specialized for issues (multi-select checkbox + RouteLink to `/board/issue/<N>`).
- **Variants/states**: open/closed; selected(bulk); blocked; grouped (under epic header); compact(mobile card). hover/focus(keyboard).
- **Reuse**: StatusListRow + StatusChip + LabelChip + AssigneeAvatar + Badge + RouteLink.

## EpicGroupHeader
- **Purpose**: the grouping/aggregation primitive — a collapsible header over an epic's issues showing `▸ Epic: <name> (N open · M closed · subtasks x/y)`. Replaces the (removed) milestone grouping.
- **States**: collapsed/expanded; empty epic; "no epic" bucket.
- **Reuse**: PanelFrame/list section header + Badge(counts) + subtask progress; aggregation is over existing epic→task→subtask relations (no new entity).

## FilterQueryBar
- **Purpose**: the issues query surface — full-text `q` + facet dropdowns (status/label/assignee/epic/blocked/has-open-subtasks) + active-filter removable chips; serializes to URL query.
- **States**: empty (no filters) / active (chips shown) / filtered-empty result.
- **Reuse**: extends FilterBar (03) with text search + chip row; Select + StatusChip(active).

## SortControl
- **Purpose**: sort the list (updated/created/priority/status), asc/desc.
- **Reuse**: a Select/menu variant in the ActionBar.

## LabelChip
- **Purpose**: a colored issue label (GH-style). **Variants**: read chip / removable (in editor) / filter-active. **Surfaces**: issue row, detail meta, filter chips. **Reuse**: a StatusChip-adjacent pill but label-colored. Label colors are **data-driven and live OUTSIDE the 19-key token contract** — per-label values (Step-5 label-color handling), not theme tokens; the editor should warn on sub-AA label colors. Distinct from semantic StatusChip. Also catalogued as a shared primitive in `01-primitives.md`.

## AssigneeAvatar
- **Purpose**: the assignee identity (agent id → avatar/initials), or "unassigned". **Variants**: single / stacked (rare) / unassigned placeholder. **Surfaces**: issue row, detail, kanban card, bulk assign. **Reuse**: shared small Avatar primitive (also usable elsewhere later).

## IssueDetailHeader / IssueDetailBody
- **Header**: `◀ back · #N · title · lifecycle StatusChip · [close▾ w/ soft gate]`; meta strip (assignee/labels/epic/priority/slug/branch).
- **Body**: markdown description + subtask checklist + deps + gated controls (status/assignee/labels/epic/deps).
- **Reuse**: PanelFrame + Markdown + StatusChip + LabelChip + AssigneeAvatar + ConfirmButton(close gate = ApprovalCard).

## ActivityTimeline
- **Purpose**: unified, interleaved **lifecycle events + comments + linked-mail** stream on the issue detail (dispatched→in_progress→review_requested→in_review→integration_ready, with comments and dispatch mail inline). The "comments/activity timeline" GH parity.
- **Variants/states**: event item / comment item / mail item; empty (just-created).
- **Reuse**: a transcript-like list (shares item-rendering patterns with `04` TranscriptItem family) + Composer (comment box).

## BulkActionToolbar
- **Purpose**: appears on multi-select — bulk set status/label/epic/assignee + close; shows selection count; permission-gated.
- **States**: hidden(no selection) / active; busy(bulk in flight); partial-permission (some actions disabled w/ reason).
- **Reuse**: ActionBar + Button/ConfirmButton + Select; mobile = long-press → bottom-sheet variant (Modal/Sheet).

## KanbanColumn / KanbanCard (desktop)
- **Purpose**: kanban board — 5 lifecycle columns, draggable issue cards, optional swimlanes (epic/assignee).
- **States**: column(empty/populated/over-drop); card(draggable/perm-locked); member-drop-rejected(reason).
- **a11y**: keyboard drag-alternative = status select on focused card (required).
- **Mobile**: **desktop-only**; mobile uses List + status filter (interaction §Mobile divergence).
- **Reuse**: card content = IssueListRow (condensed); column header = StatusChip + count Badge. (Supersedes the generic Kanban entry in `05-domain.md` for the board.)

## KeyboardFocus affordances
- **Purpose**: GH-like keyboard nav on the list/detail (j/k move, x select, enter open, e/l edit/label, esc). Visible focus ring (a11y), roving tabindex on rows, ARIA roles on list/kanban.
- **Reuse**: a cross-cutting behavior layered on IssueListRow / KanbanCard / detail controls; aligns with the project a11y posture.

## Change / review log
- 2026-06-20 — created (Step 2): board deepened to GH Issues + Milestones; board-specific parts inventoried; shared parts reused. Kanban consolidated here for the board (the generic `05` entry remains the abstract reference).
- 2026-06-20 — **Step 2 correction (prdmgr/user)**: removed milestone parts (MilestonePill / MilestoneProgressRow / MilestoneCard) and all milestone flows; milestones were a maturity benchmark, not a feature. Added **EpicGroupHeader** as the grouping/aggregation part. FilterQueryBar/SortControl/IssueDetail facets dropped `milestone`; SegmentedControl reduced to `List/Board`. AssigneeAvatar + LabelChip remain shared primitives (backed by existing assignee/label data).
- 2026-06-20 — Step 4 cross-review: LabelChip colors clarified as data-driven, **outside the 19-key token contract** (Step-5, not Step-3); AssigneeAvatar + LabelChip promoted to atoms in `01-primitives.md`.
