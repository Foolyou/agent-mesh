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

## Change log / sources read
- 2026-06-21 — created (Phase A commit 2). Sources: `../interaction/03-board-view.md`,
  `docs/design/issue-panel.md`; `src/board.ts`, `BoardPanel.tsx`, `boards/<mesh>.json`
  (CAS), `src/control-plane.ts` board_* tools (list/create_task/create_subtask/set_status/
  comment/create_epic/lifecycle/set_task_labels/create_label/dispatch).
- Milestones intentionally absent (maturity benchmark only); Epic is the aggregation primitive.
