# UI redesign — Step 2 component inventory · index

Pipeline `ui-design-pipeline` SKILL **Step 2 only** (parts/components inventory + backward consistency). Branch `task/ui-redesign-pipeline`. Derived from the 12 Step 1 interaction docs in `../interaction/`.
This is the **Step 2 gate artifact**. Fidelity stays low (what the part is + where it's reused), not pixels/tokens (tokens = Step 3). No code.

Detail docs: `01-primitives.md` · `02-surfaces-and-layout.md` · `03-lists-and-data.md` · `04-conversation.md` · `05-domain.md` · `06-board.md` (GitHub-Issues depth).

## Backward-consistency findings (this is the point of Step 2)
While inventorying, these cross-page one-offs in Step 1 were unified into shared components; **Step 1 docs were back-edited first** to reference the unified part (see each component's "Step-1 fix" + the Step 1 docs' change logs):
1. **StatusListRow** — Step 1 described mesh rows, mobile agent cards, board task rows, harness rows, device rows, channel sender/binding rows, notification items as separate things. They are one component (leading status chip + title + meta + trailing actions) with variants. → unified.
2. **ApprovalCard** — runtime "permission approve/deny card", assistant "confirm card", channels "sender approve/revoke" all share one inline approve/deny pattern. → unified.
3. **PanelFrame (Card)** — "panel" / "card" / "right-context pane" / each app surface's container are one surface frame (head + body, `surface-raised` + `border`). → unified.
4. **SegmentedControl** — view switcher `[运行态|看板]`, board `[list|kanban]`, conversation agent tabs, RailLogs seg-tabs are one segmented/tab control. → unified.
5. **EmptyState / ErrorBanner / Skeleton** — every page's empty/loading/error states are three shared feedback components, not per-page bespoke. → unified.
6. **StatusChip** — already canonical in Step 1 `00-index`; confirmed every status surface uses the same 6-value set.
7. **RouteLink** — every nav item (nav rows, switcher, app entries, artifact links) is the same real-`<a href>` + SPA-intercept link. → unified.
8. **Composer** — runtime + assistant share one composer.

## Component → page reuse matrix
(✓ used · D desktop-only · M mobile-only)
| Component | shell | runtime | board | new-mesh | assistant | harness | channels | doctor | settings | notif | file | auth |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| StatusChip | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ |
| Button / ConfirmButton | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| RouteLink | ✓ | ✓ | ✓ | | ✓ | | | | | ✓ | ✓ | |
| Badge (count) | ✓ | ✓ | ✓ | | | ✓ | ✓ | | | ✓ | | |
| PanelFrame (Card) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| SegmentedControl/Tabs | ✓ | ✓ | ✓ | | | | | | ✓ | | | |
| StatusListRow | ✓ | ✓(M agentcard) | ✓ | ✓(agent rows) | | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| FilterBar | | | ✓ | | | | | | | ✓ | | |
| ActionBar | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| EmptyState | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | | | ✓ | | |
| ErrorBanner / offline | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Skeleton | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Spinner/ProgressBar | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ |
| Input/Select/Textarea | ✓(select) | | ✓(filter) | ✓ | | | ✓ | | ✓ | | | ✓ |
| InfoIcon/Tooltip | ✓ | ✓ | ✓ | ✓ | | ✓ | | ✓ | ✓ | | | |
| Composer | | ✓ | | | ✓ | | | | | | | |
| TranscriptItem family | | ✓ | | | ✓ | | | | | | (AuthedImage) | |
| ApprovalCard | | ✓ | | | ✓ | ✓(confirm) | ✓ | | | | | ✓(bootstrap) |
| AttachmentCard / AuthedImage | | ✓ | | | ✓ | | | | | | ✓ | |
| Lightbox | | ✓ | | | ✓ | | | | | | ✓ | |
| Modal/Drawer/Sheet | ✓ | | ✓(detail) | ✓ | | ✓(install) | | | | ✓(drawer) | | |
| Topology graph | | ✓ D | | | | | | | | | | |
| AgentCard (=StatusListRow variant) | | ✓ M | | | | | | | | | | |
| KanbanColumn/Card | | | ✓ D | | | | | | | | | |
| InstallProgress | | | | | | ✓ | | | | | | |
| VersionLine (adapter·body) | | | | | | ✓ | | | | | | |
| ThemePicker | | | | | | | | | ✓ | | | |
| DeviceRow (=StatusListRow variant) | | | | | | | | | ✓ | | | |
| NotificationItem (=StatusListRow variant) | | | | | | | | | | ✓ | | |
| BottomTabs | ✓ M | | | | | | | | | | | |
| MeshSelector | ✓ | | | | | | | | | | | |
| Markdown/CodeBlock | | ✓ | | | ✓ | | | | | | ✓ | |
| Avatar (AssigneeAvatar) | | | ✓ | | | | | | | | | |
| LabelChip | | | ✓ | | | | | | | | | |
| Topbar/LeftNav/RightContext (composed regions) | ✓ | | | | | | | | | | | |

## Coverage summary
~34 distinct parts grouped into 5 detail docs. Atoms (chip/button/link/badge/input/icon/skeleton/spinner) → `01`. Surfaces & layout (panel/tabs/modal/shell regions/selector) → `02`. Lists & data (StatusListRow + variants, filter, feedback states, version line) → `03`. Conversation (transcript family, composer, approval, attachment, lightbox, markdown) → `04`. Domain widgets (topology, kanban, install-progress, theme-picker, builder) → `05`.

## Open questions
None blocking. One product-boundary note carried from Step 1 (device approve in WebUI vs host-CLI, settings doc) remains a gate-time question for prdmgr, not a component decision.

## Change / review log
- 2026-06-20 — created (Step 2): inventory + 5 detail docs; 8 backward-consistency unifications applied to Step 1 docs (logged in each).
- 2026-06-20 — Step 4 cross-review: added Avatar (AssigneeAvatar) + LabelChip to the matrix and promoted them to atoms in `01-primitives.md`; noted LabelChip colors are outside the 19-key token contract. See `../04-cross-review.md`.

## Step 2 addendum — Board deepening (2026-06-20, prdmgr/user)
Board raised to **GitHub-Issues** maturity (see `../interaction/03-board-view.md`, deepened). Board-specific parts are inventoried in **`06-board.md`** (added to the detail-doc set): IssueListRow (StatusListRow variant), EpicGroupHeader (grouping/aggregation primitive), FilterQueryBar (extends FilterBar), SortControl, LabelChip, AssigneeAvatar (new shared Avatar primitive), IssueDetailHeader/Body, ActivityTimeline (shares TranscriptItem patterns), BulkActionToolbar, KanbanColumn/Card (desktop; consolidates the abstract `05` Kanban for the board), KeyboardFocus affordances.
- **Backward consistency held**: board reuses StatusChip / PanelFrame / SegmentedControl(List·Board) / FilterBar / EmptyState·ErrorBanner·Skeleton / ApprovalCard(soft close gate) / Composer(comment box) / RouteLink; the Step 1 board doc was back-edited first (deepened + components-used + change log).
- **New shared primitives surfaced by board**: `AssigneeAvatar` (small Avatar) and `LabelChip` (label-colored pill, distinct from semantic StatusChip) — usable beyond board later. **Now catalogued as atoms in `01-primitives.md`** (promoted in Step 4) and listed in the matrix above. Both are backed by the **existing** assignee/label data; LabelChip colors are data-driven, outside the 19-key token contract.
- **No new data entity**: all board parts map to the existing `board.ts` / `issue-panel.md` model (Epic → Task → Subtask, labels, assignees, lifecycle, comments, priority, deps).

## Step 2 correction — milestones removed (2026-06-20, prdmgr/user)
GitHub *Milestones* was a **maturity benchmark, not a feature request**. Corrected: removed `BoardMilestone {id,title,due?,description?}` / `Task.milestoneId?`, the milestone components (MilestonePill / MilestoneProgressRow / MilestoneCard), the Milestones sub-view + `/board/milestone/<id>` route, and all milestone grouping/aggregation/progress/due/overdue flows. **Epic** is now the grouping/aggregation primitive (`EpicGroupHeader`). SegmentedControl reduced to `List/Board`; FilterQueryBar/SortControl/IssueDetail facets dropped `milestone`. GH-Issues maturity preserved over the existing data model. Preserved mature parts: IssueListRow, FilterQueryBar, SortControl, LabelChip, AssigneeAvatar, IssueDetailHeader/Body, ActivityTimeline, BulkActionToolbar, KanbanColumn/Card, keyboard affordances.

## Change / review log — Board addendum
- 2026-06-20 — Step 2 board deepening: added `06-board.md`; Step 1 `03-board-view.md` deepened first; inventory + matrix extended.
- 2026-06-20 — Step 2 correction: milestones removed (benchmark, not feature); EpicGroupHeader added as the grouping/aggregation part; back-applied to `03-board-view.md` + `06-board.md`.
- 2026-06-20 — Step 4 re-review (v2 tokens): PanelFrame unification note → `surface-raised`/`border` (v2 semantic). See `../04-cross-review.md`.
