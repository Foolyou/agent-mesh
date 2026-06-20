# Step 2 components — 06 Board (GitHub Issues + Milestones depth)

Board is the highest-part-count surface (deepened to GH Issues + Milestones, see `../interaction/03-board-view.md`). Board-specific parts below; shared parts (StatusChip, PanelFrame, SegmentedControl, FilterBar, EmptyState/ErrorBanner/Skeleton, ApprovalCard, RouteLink, Composer) are reused from `01`–`04`, not redefined.

## IssueListRow
- **Purpose**: one issue in the list — `#N · lifecycle StatusChip · title · AssigneeAvatar · LabelChips · MilestonePill · priority · subtask progress · blocked Badge · updated-at`. A **StatusListRow variant** specialized for issues (multi-select checkbox + RouteLink to `/board/issue/<N>`).
- **Variants/states**: open/closed; selected(bulk); blocked; grouped (under epic/milestone header); compact(mobile card). hover/focus(keyboard).
- **Reuse**: StatusListRow + StatusChip + LabelChip + AssigneeAvatar + MilestonePill + Badge + RouteLink.

## FilterQueryBar
- **Purpose**: the issues query surface — full-text `q` + facet dropdowns (status/label/assignee/milestone/epic/blocked/has-open-subtasks) + active-filter removable chips; serializes to URL query.
- **States**: empty (no filters) / active (chips shown) / filtered-empty result.
- **Reuse**: extends FilterBar (03) with text search + chip row; Select + StatusChip(active).

## SortControl
- **Purpose**: sort the list (updated/created/priority/status/milestone-due), asc/desc.
- **Reuse**: a Select/menu variant in the ActionBar.

## LabelChip
- **Purpose**: a colored issue label (GH-style). **Variants**: read chip / removable (in editor) / filter-active. **Surfaces**: issue row, detail meta, filter chips. **Reuse**: a StatusChip-adjacent pill but label-colored (Step-3 label color tokens); distinct from semantic StatusChip.

## AssigneeAvatar
- **Purpose**: the assignee identity (agent id → avatar/initials), or "unassigned". **Variants**: single / stacked (rare) / unassigned placeholder. **Surfaces**: issue row, detail, kanban card, bulk assign. **Reuse**: shared small Avatar primitive (also usable elsewhere later).

## MilestonePill / MilestoneProgressRow / MilestoneCard
- **MilestonePill**: compact `◑ <name> (due)` on issue rows/detail; overdue flag.
- **MilestoneProgressRow** (Milestones list): title · due (relative + overdue) · **completion bar** (closed/total) · open/closed counts → detail. A StatusListRow variant + ProgressBar.
- **MilestoneCard / detail**: progress bar + due/description edit + its aggregated IssueList (scoped filter).
- **States**: on-track / due-soon / overdue / complete; empty (no issues).
- **Reuse**: StatusListRow + ProgressBar + EmptyState; milestone is the **new data entity** (BoardMilestone) flagged in interaction §Open-questions.

## IssueDetailHeader / IssueDetailBody
- **Header**: `◀ back · #N · title · lifecycle StatusChip · [close▾ w/ soft gate]`; meta strip (assignee/labels/milestone/priority/slug/branch).
- **Body**: markdown description + subtask checklist + deps + gated controls (status/assignee/labels/milestone/deps).
- **Reuse**: PanelFrame + Markdown + StatusChip + LabelChip + AssigneeAvatar + MilestonePill + ConfirmButton(close gate = ApprovalCard).

## ActivityTimeline
- **Purpose**: unified, interleaved **lifecycle events + comments + linked-mail** stream on the issue detail (dispatched→in_progress→review_requested→in_review→integration_ready, with comments and dispatch mail inline). The "comments/activity timeline" GH parity.
- **Variants/states**: event item / comment item / mail item; empty (just-created).
- **Reuse**: a transcript-like list (shares item-rendering patterns with `04` TranscriptItem family) + Composer (comment box).

## BulkActionToolbar
- **Purpose**: appears on multi-select — bulk set status/label/milestone/assignee + close; shows selection count; permission-gated.
- **States**: hidden(no selection) / active; busy(bulk in flight); partial-permission (some actions disabled w/ reason).
- **Reuse**: ActionBar + Button/ConfirmButton + Select; mobile = long-press → bottom-sheet variant (Modal/Sheet).

## KanbanColumn / KanbanCard (desktop)
- **Purpose**: kanban board — 5 lifecycle columns, draggable issue cards, optional swimlanes (epic/assignee/milestone).
- **States**: column(empty/populated/over-drop); card(draggable/perm-locked); member-drop-rejected(reason).
- **a11y**: keyboard drag-alternative = status select on focused card (required).
- **Mobile**: **desktop-only**; mobile uses List + status filter (interaction §Mobile divergence).
- **Reuse**: card content = IssueListRow (condensed); column header = StatusChip + count Badge. (Supersedes the generic Kanban entry in `05-domain.md` for the board.)

## KeyboardFocus affordances
- **Purpose**: GH-like keyboard nav on the list/detail (j/k move, x select, enter open, e/l/m edit/label/milestone, esc). Visible focus ring (a11y), roving tabindex on rows, ARIA roles on list/kanban.
- **Reuse**: a cross-cutting behavior layered on IssueListRow / KanbanCard / detail controls; aligns with the project a11y posture.

## Change / review log
- 2026-06-20 — created (Step 2): board deepened to GH Issues + Milestones; board-specific parts inventoried; shared parts reused (StatusListRow/PanelFrame/SegmentedControl/FilterBar/EmptyState/ErrorBanner/ApprovalCard/Composer). Kanban consolidated here for the board (the generic `05` entry remains the abstract reference).
