# Board view (C) — interaction (Step 1, deepened to GitHub-Issues maturity)

Routes: `/mesh/<m>/board` · `/mesh/<m>/board/issue/<N>` (issue detail) · query for view/filter/sort (`?view=list|kanban&status=…&label=…&assignee=…&epic=…&sort=…&q=…`). Inputs: ui-redesign.md §1.6, **`docs/design/issue-panel.md`** (existing GH-Issues design + data model/lifecycle/permission), `src/web/client/BoardPanel.tsx`, `board.ts` / `board_*` MCP / `boards/<mesh>.json` / lifecycle auto-reflow.

> Depth bar (prdmgr/user): **≥ GitHub Issues maturity** — not the simple board. GitHub *Milestones* was named only as a **maturity benchmark**, NOT a request to add a milestones feature (clarified 2026-06-20). So: no `BoardMilestone` entity, no milestone components, no due/overdue/progress-by-milestone flows. Apply GH-Issues-level maturity strictly to the **existing** data model (Epic → Task → Subtask, labels, assignees, lifecycle statuses, comments/activity, priority, deps, subtask progress). **Epic is the grouping/aggregation primitive.** Desktop = high-investment list/detail/kanban; mobile = simplified but genuinely usable, not a toy.

## Function
The per-mesh project tracker: epics → issues(tasks) → subtasks with labels, assignees, lifecycle status, comments/activity timeline, dependencies, and priority. **Epics group and aggregate issues** (the grouping primitive). A router dispatch station hands an issue to an agent (`send_mail` + slug/branch linkage) and status **auto-reflows** `todo→in_progress→in_review` from machine lifecycle events (issue-panel §5). Peer to runtime via the switcher; "C as primary" = default-view preference flip.

## Core user actions
- **Issues (GH-Issues-like)**: search/filter/sort the issue list; open/closed/lifecycle states; open an issue → detail; comment; set labels/assignee/priority/deps/status (per permission matrix, issue-panel §4); create issue (router/human); **bulk operations** (multi-select → set status/label/epic/assignee/close); keyboard navigation (j/k move, x select, enter open, e edit, l label).
- **Epics (grouping/aggregation)**: group the list by epic; filter by epic; see an epic's aggregated open/closed counts + subtask roll-up; assign issue → epic (existing relation).
- **Dispatch**: router dispatches an issue to an assignee from the row/detail (`dispatch▾`).

## States
- **empty**: no issues → EmptyState "Create the first issue" CTA (or "dispatch from runtime").
- **loading**: board snapshot fetch → Skeleton list/columns.
- **populated**: issues rendered; status/lifecycle chips; counts.
- **filtered-empty**: filters match nothing → "no issues match — clear filters".
- **busy**: a mutation (status/assignee/label/epic/bulk/dispatch) in flight → optimistic update + spinner; **CAS 409** (`expectedBoardRevision`) → refetch + reconcile note (issue-panel §3).
- **permission**: an action the actor can't perform is hidden/disabled with reason (matrix §4; e.g. member can't create/close, can't drag to done).
- **error**: load/mutation failed → ErrorBanner + retry.
- **offline**: last-known board + reconnecting; mutations disabled.

## Desktop (high-investment; 2 sub-views via SegmentedControl)
**View switch:** `[List · Board(kanban)]` + query/filter/sort bar + bulk toolbar (appears on selection).

### List (GitHub Issues)
```
┌ board · [List|Board]   q:[search…] status▾ label▾ assignee▾ epic▾ sort▾   [+ Issue]      ┐
│ ☑ select-all   (bulk: set status▾ label▾ epic▾ assignee▾  close)      12 open · 30 closed │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ Epic: Onboarding   (5 open · 3 closed · subtasks 9/14)                                    │
│  ☐ #12  ▶ in_review   Add device-auth page   ◌@codex-1  🏷auth 🏷ui   ⛔blocked   2d         │
│  ☐ #14  ● todo        Wire route fallback     ◌@—        🏷infra                  1h         │
│ ▸ Epic: Polish …                                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
- Row = `#N` · lifecycle status chip · title · assignee avatar · label chips · priority · subtask progress · blocked badge · updated-at → click opens detail. Group toggle by **epic / none**. Sort by updated/created/priority/status.
- **Query/filter bar**: full-text `q` (title/description/comment) + facet dropdowns (status incl. open/closed/each lifecycle, label, assignee, epic, blocked, has-open-subtasks); active filters shown as removable chips; sharable via URL query.
- **Bulk toolbar**: appears when ≥1 selected; bulk set status/label/epic/assignee + close (gated by matrix).
- **Epic group header**: aggregated open/closed counts + subtask roll-up (the aggregation primitive; collapsible).

### Detail (`/board/issue/<N>`)
```
┌ ◀ #12  Add device-auth page              ▶ in_review   [close ▾]            ┐
│ by router · opened 3d · assignee ◌@codex-1 · 🏷auth 🏷ui · epic:Onboarding · prio:high
│ ── description (markdown) ──                                                 │
│ subtasks: ▣▣▢ 2/3                                                            │
│ deps: blocked-by #9 (⛔ open)                                                │
│ ── activity timeline ──  (lifecycle + comments + linked mail, interleaved)   │
│   • dispatched → in_progress  by router · 3d                                 │
│   • comment @codex-1: "branch up" · 2d                                       │
│   • review_requested → in_review · 1d                                        │
│ ┌ comment box … ─────────────────────────────────────────────────────────┐ │
│ controls (gated): status▾ assignee▾ labels▾ epic▾ deps▾  slug/branch       │
└──────────────────────────────────────────────────────────────────────────┘
```
- Header (title/#N/status/close), meta strip (assignee/labels/epic/priority/slug/branch), markdown body, subtask checklist, deps, **unified activity timeline** (lifecycle events + comments + linked-mail, issue-panel §3), comment composer, gated controls. Close shows the soft acceptance gate (issue-panel §5.6).

### Kanban (`Board`)
```
[ todo ] [ in_progress ] [ in_review ] [ done ] [ cancelled ]   swimlanes: epic▾/assignee▾
  cards (drag = set_status, perm-gated; keyboard: status select on card)
```
- Columns = the 5 lifecycle statuses; cards = issues; drag = `set_task_status` (member ≤ in_review; done/cancelled reject member drops with reason). Swimlanes by epic/assignee. **Keyboard alt** to drag (status select on focused card).

## Mobile (simplified but usable)
```
┌ board  [List]  q:[…] status▾ ⋯ ┐   tap →  ┌ issue #12 ──────────┐
│ #12 ▶ Add device-auth  @codex-1 🏷auth │ ──▶ │ ▶ in_review  [close]  │
│ #14 ● Wire route       @—              │     │ desc · subtasks 2/3   │
│ (long-press = multi-select → bulk sheet)│  ◀  │ activity timeline     │
└─────────────────────────────────────────┘     │ ┌ comment … ┐         │
                                                 │ status▾ label▾ ⋯     │
                                                 └───────────────────────┘
```
- **List + Detail** (the two that matter on phone); query + key facet filters (incl. epic) in a filter sheet; bulk via long-press → bottom-sheet actions; epic shown as a group header / filter.

## Mobile divergence
**Kanban drag is desktop-only** (touch drag is error-prone) → mobile gets list + status filter (status changes via the detail/row status select). **Swimlanes, multi-column kanban, dense bulk grids** desktop-only; mobile bulk via long-press sheet. Detail/comment/lifecycle timeline fully usable on mobile (spec §1.6/§1.7). Not a toy: search, filter, group-by-epic, assign, comment, status, close all work on mobile.

## Open questions
- Bulk-op permission semantics (which bulk actions a router vs human may run) inherit the issue-panel §4 matrix; confirm bulk-close uses the same soft acceptance gate per issue.
- All board surfaces map to the **existing** `board.ts` / `issue-panel.md` data model — no new data entity is introduced by this view (milestones explicitly NOT added).

## Change / review log
- 2026-06-20 — created (Step 1).
- 2026-06-20 — **Step 2 deepening (prdmgr/user)**: raised board to GitHub Issues maturity — issue list search/filter/sort, issue detail with activity timeline, bulk operations, keyboard a11y, kanban swimlanes + keyboard-drag-alt. New board component parts emitted in Step 2 (`../components/06-board.md`).
- 2026-06-20 — **Step 2 correction (prdmgr/user)**: GitHub *Milestones* was a maturity benchmark only, not a feature request. Removed the Milestones sub-view, `/board/milestone/<id>` route, `BoardMilestone` entity / `Task.milestoneId?`, milestone components (Pill/ProgressRow/Card), and all milestone grouping/aggregation/progress/due/overdue flows. **Epic is now the grouping/aggregation primitive**; view switch reduced to `[List · Board]`. GH-Issues maturity preserved over the existing data model only.

## Components used (Step 2)
Board-specific parts in `../components/06-board.md` (IssueListRow, FilterQueryBar, SortControl, LabelChip, AssigneeAvatar, IssueDetailHeader/Body, ActivityTimeline, BulkActionToolbar, KanbanColumn/Card, EpicGroupHeader, lifecycle StatusChip, keyboard-focus affordances). Shared parts reused: StatusChip, PanelFrame, SegmentedControl (List/Board), StatusListRow (issue row = variant), FilterBar, EmptyState/ErrorBanner/Skeleton, ApprovalCard (soft close gate confirm), RouteLink, Composer (comment box). See `../components/00-inventory.md`.

## Change / review log — Step 2 addendum
- 2026-06-20 — Step 2 back-consistency: board parts unified to shared components where applicable; board-specific depth captured in `../components/06-board.md`; issue row = StatusListRow variant; comment box = Composer; close-gate = ApprovalCard.
- 2026-06-20 — Step 2 correction back-consistency: milestone parts removed from `../components/06-board.md` and `../components/00-inventory.md`; EpicGroupHeader is the aggregation part; AssigneeAvatar + LabelChip remain shared primitives (backed by existing assignee/label data).
