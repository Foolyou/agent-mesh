# 03 · Board view (C) — coverage

**Scope / routes.** Per-mesh project tracker at GitHub-Issues maturity: epics → issues
(tasks) → subtasks with labels, assignees, lifecycle status, comments/activity
timeline, dependencies, priority; router dispatch station; lifecycle auto-reflow.
`/mesh/<m>/board` · `/mesh/<m>/board/issue/<N>` · query
`?view=list|kanban&status&label&assignee&epic&sort&q`.
**Desktop/mobile.** Desktop: List (filter/sort/bulk + epic groups + rich rows),
Detail (meta + timeline + deps + comment), Kanban (5 lifecycle columns + swimlanes).
Mobile: List + Detail (kanban desktop-only △; bulk via long-press sheet).
**Exists vs net-new.** [E] — board data model, `board_*` MCP tools, lifecycle auto-reflow,
`BoardPanel.tsx`. [N] — the GH-Issues-maturity redesign surface (rich list, unified
timeline detail, kanban swimlanes, bulk toolbar, dispatch panel UI) layered on the
existing model only (no new entity; milestones explicitly NOT added).
**Inputs/sources read.** `../interaction/03-board-view.md`, `docs/design/issue-panel.md`;
repo: `src/board.ts` (model/lifecycle), `src/web/client/BoardPanel.tsx`
(filter/sort/labels/labelForeground/EpicGroup), `boards/<mesh>.json` (CAS revision),
`src/control-plane.ts` board_* tools (`board_list`, `board_create_task`,
`board_create_subtask`, `board_set_status`, `board_comment`, `board_create_epic`,
`board_lifecycle`, `board_set_task_labels`, `board_create_label`, `board_dispatch`).

## Function / control / action checklist
- **View switch List|Board(kanban)** [E] — SegmentedControl; query `?view`.
- **Query/filter/sort bar** [E] — full-text `q` + facets (status incl. open/closed/lifecycle, label, assignee, epic, blocked, has-open-subtasks) + sort (updated/created/priority/status); active filters as removable chips; URL-sharable.
- **+ Issue (create)** [E] — router/human (permission matrix, issue-panel §4).
- **Bulk toolbar** [N-redesign] — appears on selection: bulk set status/label/epic/assignee + close (gated).
- **Epic group header** [E] — aggregated open/closed + subtask roll-up; collapsible; group by epic/none.
- **Issue row** [E] — `#N` · lifecycle StatusChip · title · assignee avatar · label chips · priority · subtask progress · blocked badge · updated-at → detail.
- **Issue detail** [E] — header/status/close, meta strip (assignee/labels/epic/priority/slug/branch), markdown body, subtask checklist, deps (blocked-by), **unified activity timeline** (lifecycle + comments + linked mail), comment composer, gated controls.
- **Close (soft acceptance gate)** [E] — issue-panel §5.6 (ApprovalCard-style confirm).
- **Kanban** [E] — 5 lifecycle columns; drag = `board_set_status` (member ≤ in_review; done/cancelled reject member with reason); swimlanes by epic/assignee; keyboard-drag-alt.
- **Router dispatch** [E] — dispatch issue → assignee (`board_dispatch`; `send_mail` + slug/branch); from row/detail/dispatch panel.
- **Lifecycle auto-reflow** [E] — `todo→in_progress→in_review` from machine events (`board_lifecycle`); visualized as kanban columns / status path / timeline.
- **Keyboard nav** [N-redesign] — j/k move, x select, enter open, e edit, l label.
- **Board fullscreen toggle** [E] — `board-fs-btn`/`setFullscreen` expands the board panel within the detail view. (audit #22)
- **Group-by-epic toggle** [E] — `groupByEpic` checkbox toggles list grouping by epic. (audit #23)
- **Label management (CRUD + color palette)** [E] — `LabelManager`/`setManage` (`board-manage-labels`): create/rename/recolor/delete labels with an AA `PalettePicker`. (audit #24)
- **Create epic** [E] — `CreateRow` epic input (running mesh). (audit #25 per triage → explicit in board)
- **Reopen closed issue** [E] — reopen a done/cancelled issue → records `reopened` lifecycle event → in_progress (terminal only). (audit #25)
- **Deep links** [E] — list query, `/board/issue/<N>`.

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| View switch [E] | ✓ | ✓ | ✓ | ✓ | N/A | ✓ | ✓(last-known) | N/A | ✓(List/Board) | △(List only; kanban deferred) |
| Filter/sort bar [E] | ✓(no issues) | ✓ | ✓ | ✓ | N/A | ✓(applying) | △(disabled offline) | ✓(filtered-empty→clear) | ✓(full bar) | △(filter sheet) |
| + Issue (create) [E] | ✓(first-issue CTA) | N/A | ✓ | ✓(fail+retry) | △(hidden if can't create) | ✓(in flight) | △(disabled offline) | N/A | ✓ | ✓ |
| Bulk toolbar [N] | N/A(none selected) | N/A | ✓(on selection) | ✓(partial fail) | △(per-action gated) | ✓(CAS-409 reconcile) | △(disabled offline) | ✓(N selected; select-all) | ✓ | △(long-press sheet) |
| Epic group header [E] | ✓(no issues) | ✓ | ✓(counts+rollup) | ✓ | N/A | ✓ | ✓(stale) | ✓(many epics; collapse) | ✓ | ✓(group/filter) |
| Issue row [E] | N/A | ✓(skeleton row) | ✓ | ✓ | △(perm on inline edit) | ✓(optimistic) | ✓(last-known) | ✓(long title trunc; many labels) | ✓(rich) | ✓(condensed card) |
| Issue detail [E] | N/A | ✓(skeleton) | ✓ | ✓(load/mutation+retry) | △(gated controls disabled+reason) | ✓(optimistic+spinner) | ✓(last-known; mutations off) | ✓(long body; many subtasks/deps/timeline) | ✓ | ✓ |
| Close (soft gate) [E] | N/A | N/A | ✓ | ✓ | ✓(acceptance gate; member can't) | ✓(closing) | △(disabled) | ✓(bulk-close per-issue gate) | ✓ | ✓ |
| Kanban [E] | ✓(empty columns) | ✓(skeleton) | ✓ | ✓ | △(drag gated; reason on reject) | ✓(drag→set_status) | △(disabled) | ✓(N cards; swimlanes; scroll) | ✓ | △(deferred; use List+status) |
| Router dispatch [E] | ✓(dispatch from runtime hint) | N/A | ✓ | ✓(fail+retry) | △(router/operator only) | ✓(dispatching) | △(disabled) | N/A | ✓(row/detail/panel) | △(detail dispatch) |
| Lifecycle auto-reflow [E] | N/A | ✓ | ✓(status moves) | ✓ | N/A | ✓(reflowing) | ✓(replays on reconnect) | ✓(reopened-cycle idempotent) | ✓(columns/path/history) | ✓(status+timeline) |
| Keyboard nav [N] | N/A | N/A | ✓ | N/A | △(gated actions) | ✓ | △ | ✓(list traversal) | ✓ | N/A(touch) |
| Deep links [E] | ✓ | ✓ | ✓ | ✓(bad #N→fallback) | ✓(unauth→gate) | N/A | ✓ | N/A | ✓ | ✓ |
| Board fullscreen toggle [E] (audit #22) | ✓ | ✓ | ✓(expand/restore) | ✓ | N/A | N/A | ✓(last-known) | ✓(more rows visible) | ✓ | △(mobile already full-width) |
| Group-by-epic toggle [E] (audit #23) | ✓(no issues) | ✓ | ✓(grouped/flat) | ✓ | N/A | ✓ | ✓(stale) | ✓(many epics) | ✓ | ✓(filter sheet) |
| Label management CRUD+palette [E] (audit #24) | ✓(no labels) | ✓ | ✓(create/rename/recolor/delete) | ✓(action failed) | △(running + perm only) | ✓(in flight) | △(disabled offline) | ✓(many labels scroll) | ✓ | △(simplified/deferred) |
| Create epic [E] (audit #25) | ✓(first epic) | N/A | ✓(create) | ✓(fail+retry) | △(create perm) | ✓(creating) | △(disabled offline) | N/A | ✓ | △(create via sheet) |
| Reopen closed issue [E] (audit #25) | N/A | N/A | ✓(terminal→reopen) | ✓(fail+retry) | △(operator/router) | ✓(reopening) | △(disabled offline) | N/A | ✓ | ✓ |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 2). Sources: `../interaction/03-board-view.md`,
  `docs/design/issue-panel.md`; `src/board.ts`, `BoardPanel.tsx`, `boards/<mesh>.json`
  (CAS), `src/control-plane.ts` board_* tools (list/create_task/create_subtask/set_status/
  comment/create_epic/lifecycle/set_task_labels/create_label/dispatch).
- Milestones intentionally absent (maturity benchmark only); Epic is the aggregation primitive.
- 2026-06-21 — backward-consistency completion (audit `14`): +board fullscreen (#22),
  +group-by-epic toggle (#23), +label CRUD/palette (#24), +create-epic & reopen (#25,
  explicit in board per triage). `BoardPanel.tsx` (`LabelManager`/`PalettePicker`/`CreateRow`).
- 2026-06-21 — Phase B Step 2 mockup补漏 (`UiMockup.tsx`): #22–#25 rendered in the guarded
  `/__ui-mockup` board. Each board subview header gets a 🗖/🗕 fullscreen toggle →
  standalone desktop `BoardFullFrame` (`?boardFs=1`); the filter bar gets a 「按 Epic
  分组」checkbox (#23) and a 「🏷 标签」toggle → `BoardLabelManager` (`?boardManage=1`):
  create/rename/recolor/delete with the AA `LABEL_PALETTE` swatch picker (#24); a
  `BoardCreateRow` adds new task + new epic inputs (#25); terminal (done/cancelled)
  issue rows + detail expose 「↺ reopen」 (#25). Mobile keeps group-by-epic in the filter
  row; fullscreen/manager stay desktop-only (matrix △). Index (`?index=1`) 03 row synced
  with the new deep links. All prior board all-state desktop/mobile coverage intact.
- 2026-06-21 — Phase B user-review **C4 (board filter area redesign · GH-Issues direction)**:
  the desktop list filter area (`BoardFilterBar` in `UiMockup.tsx`, `data-board-filters`)
  is redesigned toward GitHub Issues. A **persistent 🔍 search** accepts query tokens
  (placeholder `搜索 issue… 例如 status:open label:bug`) and a **筛选▾** dropdown
  (`data-board-filter-toggle` → `?boardFilters=1`, `data-board-filter-menu` `role=menu`)
  now **owns** the status/label/assignee/epic pickers + 按 Epic 分组 (moved out of the
  inline row). Applied filters render as **removable `×` chips** beneath the row
  (`data-board-applied-filters` / `data-filter-chip` + 清除全部). The **right-side action
  group** holds the List/Board view-switch + sort + 新建 (+ 管理标签/Dispatch when room).
  **Boundary**: secondary controls (管理标签, Dispatch) **collapse into the 筛选▾ menu**
  instead of squeezing the row — the filter toolbar has **no horizontal overflow**
  (e2e asserts `scrollWidth ≤ clientWidth`); applied chips wrap. To give the central
  list more width, the **left nav** (收起导航 → floating expand) and the **right
  Epic/dispatch panel** (收起上下文) both collapse (proof shot
  `board-list-boundary-collapsed-desktop`). Mobile list keeps its own simplified filter
  row (C4 is desktop-scoped) — unchanged. Direction ① only (no alternate variant).
  New proof screenshots: `board-list-filtermenu-boundary-desktop` (menu open, collapsed
  secondary) + `board-list-boundary-collapsed-desktop`; `board-list-*-desktop` re-rendered.
