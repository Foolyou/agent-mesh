# Board view (C) — interaction (Step 1, deepened to GitHub Issues + Milestones)

Routes: `/mesh/<m>/board` · `/mesh/<m>/board/issue/<N>` (issue detail) · `/mesh/<m>/board/milestone/<id>` · query for view/filter/sort (`?view=list|kanban|milestones&status=…&label=…&assignee=…&milestone=…&sort=…&q=…`). Inputs: ui-redesign.md §1.6, **`docs/design/issue-panel.md`** (existing GH-Issues design + data model/lifecycle/permission), `src/web/client/BoardPanel.tsx`, `board.ts` / `board_*` MCP / `boards/<mesh>.json` / lifecycle auto-reflow.

> Depth bar (prdmgr/user): **≥ GitHub Issues + GitHub Milestones maturity** — not the simple board. Builds on `issue-panel.md`'s mature issues design and **adds Milestones** (note: `issue-panel.md` §2 previously excluded milestones — this requirement supersedes that). Desktop = high-investment list/detail/kanban/milestones; mobile = simplified but genuinely usable, not a toy.

## Function
The per-mesh project tracker: epics → issues(tasks) → subtasks with labels, assignees, lifecycle status, comments/activity timeline, dependencies, and **milestones** (grouping + progress + due dates). A router dispatch station hands an issue to an agent (`send_mail` + slug/branch linkage) and status **auto-reflows** `todo→in_progress→in_review` from machine lifecycle events (issue-panel §5). Peer to runtime via the switcher; "C as primary" = default-view preference flip.

## Core user actions
- **Issues (GH-Issues-like)**: search/filter/sort the issue list; open/closed/lifecycle states; open an issue → detail; comment; set labels/assignee/priority/deps/status (per permission matrix, issue-panel §4); create issue (router/human); **bulk operations** (multi-select → set status/label/milestone/assignee/close); keyboard navigation (j/k move, x select, enter open, e edit, l label, m milestone).
- **Milestones (GH-Milestones-like)**: create/edit milestone (title, due date, description); assign issues to a milestone; view milestone progress (open/closed counts + completion bar); group/filter issues by milestone; see overdue.
- **Dispatch**: router dispatches an issue to an assignee from the row/detail (`dispatch▾`).

## States
- **empty**: no issues → EmptyState "Create the first issue" CTA (or "dispatch from runtime"); no milestones → milestones empty hint.
- **loading**: board snapshot fetch → Skeleton list/columns.
- **populated**: issues rendered; status/lifecycle chips; counts.
- **filtered-empty**: filters match nothing → "no issues match — clear filters".
- **busy**: a mutation (status/assignee/label/milestone/bulk/dispatch) in flight → optimistic update + spinner; **CAS 409** (`expectedBoardRevision`) → refetch + reconcile note (issue-panel §3).
- **permission**: an action the actor can't perform is hidden/disabled with reason (matrix §4; e.g. member can't create/close, can't drag to done).
- **error**: load/mutation failed → ErrorBanner + retry.
- **offline**: last-known board + reconnecting; mutations disabled.

## Desktop (high-investment; 4 sub-views via SegmentedControl)
**View switch:** `[List · Board(kanban) · Milestones]` + query/filter/sort bar + bulk toolbar (appears on selection).

### List (GitHub Issues)
```
┌ board · [List|Board|Milestones]  q:[search…] status▾ label▾ assignee▾ milestone▾ sort▾  [+ Issue][+ Milestone]┐
│ ☑ select-all   (bulk: set status▾ label▾ milestone▾ assignee▾  close)        12 open · 30 closed           │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ Epic: Onboarding                                                                                          │
│  ☐ #12  ▶ in_review   Add device-auth page   ◌@codex-1  🏷auth 🏷ui   ◑ Milestone v1 (due 6/30)  ⛔blocked   2d │
│  ☐ #14  ● todo        Wire route fallback     ◌@—        🏷infra       ◑ Milestone v1            1h │
│ ▸ Epic: Polish …                                                                                            │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- Row = `#N` · lifecycle status chip · title · assignee avatar · label chips · milestone pill · priority · subtask progress · blocked badge · updated-at → click opens detail. Group toggle by epic / milestone / none. Sort by updated/created/priority/status/milestone-due.
- **Query/filter bar**: full-text `q` (title/description/comment) + facet dropdowns (status incl. open/closed/each lifecycle, label, assignee, milestone, epic, blocked, has-open-subtasks); active filters shown as removable chips; sharable via URL query.
- **Bulk toolbar**: appears when ≥1 selected; bulk set status/label/milestone/assignee + close (gated by matrix).

### Detail (`/board/issue/<N>`)
```
┌ ◀ #12  Add device-auth page              ▶ in_review   [close ▾]            ┐
│ by router · opened 3d · assignee ◌@codex-1 · 🏷auth 🏷ui · ◑ Milestone v1 · prio:high
│ ── description (markdown) ──                                                 │
│ subtasks: ▣▣▢ 2/3                                                            │
│ deps: blocked-by #9 (⛔ open)                                                │
│ ── activity timeline ──  (lifecycle + comments + linked mail, interleaved)   │
│   • dispatched → in_progress  by router · 3d                                 │
│   • comment @codex-1: "branch up" · 2d                                       │
│   • review_requested → in_review · 1d                                        │
│ ┌ comment box … ─────────────────────────────────────────────────────────┐ │
│ controls (gated): status▾ assignee▾ labels▾ milestone▾ deps▾  slug/branch  │
└──────────────────────────────────────────────────────────────────────────┘
```
- Header (title/#N/status/close), meta strip (assignee/labels/milestone/priority/slug/branch), markdown body, subtask checklist, deps, **unified activity timeline** (lifecycle events + comments + linked-mail, issue-panel §3), comment composer, gated controls. Close shows the soft acceptance gate (issue-panel §5.6).

### Kanban (`Board`)
```
[ todo ] [ in_progress ] [ in_review ] [ done ] [ cancelled ]   swimlanes: epic▾/assignee▾/milestone▾
  cards (drag = set_status, perm-gated; keyboard: status select on card)
```
- Columns = the 5 lifecycle statuses; cards = issues; drag = `set_task_status` (member ≤ in_review; done/cancelled reject member drops with reason). Swimlanes by epic/assignee/milestone. **Keyboard alt** to drag (status select on focused card).

### Milestones (`Milestones`)
```
┌ Milestones                                                   [+ Milestone] ┐
│ ◑ v1  due 6/30 (in 10d)   ▓▓▓▓▓▓░░░░ 6/10 done   12 open · 6 closed  →detail │
│ ◑ v2  due 7/31            ▓▓░░░░░░░░ 2/12                    →detail        │
│ (overdue ones flagged ⛔)                                                    │
└────────────────────────────────────────────────────────────────────────────┘
  milestone detail = filtered issue list scoped to that milestone + progress bar + due/description edit
```
- Milestone row = title · due date (relative + overdue flag) · **completion bar** (closed/total) · open/closed counts → detail. Detail = its aggregated issue list + progress + edit due/description. Filter the List/Kanban by milestone; assign issue→milestone from row/detail/bulk.

## Mobile (simplified but usable)
```
┌ board  [List|Milestones]  q:[…] status▾ ⋯ ┐   tap →  ┌ issue #12 ──────────┐
│ #12 ▶ Add device-auth  @codex-1 🏷auth ◑v1 │ ──────▶ │ ▶ in_review  [close]  │
│ #14 ● Wire route       @—       ◑v1        │         │ desc · subtasks 2/3   │
│ (long-press = multi-select → bulk sheet)   │  ◀ back  │ activity timeline     │
└────────────────────────────────────────────┘         │ ┌ comment … ┐         │
                                                         │ status▾ label▾ ⋯     │
                                                         └───────────────────────┘
```
- **List + Detail + Milestones** (the three that matter on phone); query + key facet filters in a filter sheet; bulk via long-press → bottom-sheet actions; milestone progress as rows.

## Mobile divergence
**Kanban drag is desktop-only** (touch drag is error-prone) → mobile gets list + status filter (status changes via the detail/row status select). **Swimlanes, multi-column kanban, dense bulk grids** desktop-only; mobile bulk via long-press sheet. Milestones present as progress rows (no multi-column board). Detail/comment/lifecycle timeline fully usable on mobile (spec §1.6/§1.7). Not a toy: search, filter, assign-to-milestone, comment, status, close all work on mobile.

## Open questions
- **Milestones are a data-model addition** beyond current `board.ts` / `issue-panel.md` (which excluded them). Needs a `BoardMilestone {id,title,due?,description?}` + `Task.milestoneId?` + `board_*` milestone commands + sanitizer defaults — flagged for prdmgr as the one real new product surface (Step 3+ data/impl, not this gate). Recommend additive/migration-safe like the labels increment.
- Bulk-op permission semantics (which bulk actions a router vs human may run) inherit the issue-panel §4 matrix; confirm bulk-close uses the same soft acceptance gate per issue.

## Change / review log
- 2026-06-20 — created (Step 1).
- 2026-06-20 — **Step 2 deepening (prdmgr/user)**: raised board to GitHub Issues + Milestones maturity — added issue list search/filter/sort, issue detail with activity timeline, bulk operations, keyboard a11y, kanban swimlanes + keyboard-drag-alt, and a new **Milestones** sub-view (grouping/progress/due/aggregation). Built on `docs/design/issue-panel.md`; routes extended (`/board/issue/<N>`, `/board/milestone/<id>`). Mobile kept simplified-but-usable. New board component parts emitted in Step 2 (`../components/06-board.md`).

## Components used (Step 2)
Board-specific parts in `../components/06-board.md` (IssueListRow, FilterQueryBar, SortControl, LabelChip, AssigneeAvatar, MilestoneProgressRow/Card, IssueDetailHeader/Body, ActivityTimeline, BulkActionToolbar, KanbanColumn/Card, lifecycle StatusChip, keyboard-focus affordances). Shared parts reused: StatusChip, PanelFrame, SegmentedControl (List/Board/Milestones), StatusListRow (issue row = variant), FilterBar, EmptyState/ErrorBanner/Skeleton, ApprovalCard (soft close gate confirm), RouteLink, Composer (comment box). See `../components/00-inventory.md`.

## Change / review log — Step 2 addendum
- 2026-06-20 — Step 2 back-consistency: board parts unified to shared components where applicable; board-specific depth captured in `../components/06-board.md`; issue row = StatusListRow variant; comment box = Composer; close-gate = ApprovalCard.
