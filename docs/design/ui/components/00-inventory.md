# UI redesign — Step 2 component inventory · index

Pipeline `ui-design-pipeline` SKILL **Step 2 only** (parts/components inventory + backward consistency). Branch `task/ui-redesign-pipeline`. Derived from the 12 Step 1 interaction docs in `../interaction/`.
This is the **Step 2 gate artifact**. Fidelity stays low (what the part is + where it's reused), not pixels/tokens (tokens = Step 3). No code.

Detail docs: `01-primitives.md` · `02-surfaces-and-layout.md` · `03-lists-and-data.md` · `04-conversation.md` · `05-domain.md`.

## Backward-consistency findings (this is the point of Step 2)
While inventorying, these cross-page one-offs in Step 1 were unified into shared components; **Step 1 docs were back-edited first** to reference the unified part (see each component's "Step-1 fix" + the Step 1 docs' change logs):
1. **StatusListRow** — Step 1 described mesh rows, mobile agent cards, board task rows, harness rows, device rows, channel sender/binding rows, notification items as separate things. They are one component (leading status chip + title + meta + trailing actions) with variants. → unified.
2. **ApprovalCard** — runtime "permission approve/deny card", assistant "confirm card", channels "sender approve/revoke" all share one inline approve/deny pattern. → unified.
3. **PanelFrame (Card)** — "panel" / "card" / "right-context pane" / each app surface's container are one surface frame (head + body, bg-raise + line). → unified.
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
| Topbar/LeftNav/RightContext (composed regions) | ✓ | | | | | | | | | | | |

## Coverage summary
~34 distinct parts grouped into 5 detail docs. Atoms (chip/button/link/badge/input/icon/skeleton/spinner) → `01`. Surfaces & layout (panel/tabs/modal/shell regions/selector) → `02`. Lists & data (StatusListRow + variants, filter, feedback states, version line) → `03`. Conversation (transcript family, composer, approval, attachment, lightbox, markdown) → `04`. Domain widgets (topology, kanban, install-progress, theme-picker, builder) → `05`.

## Open questions
None blocking. One product-boundary note carried from Step 1 (device approve in WebUI vs host-CLI, settings doc) remains a gate-time question for prdmgr, not a component decision.

## Change / review log
- 2026-06-20 — created (Step 2): inventory + 5 detail docs; 8 backward-consistency unifications applied to Step 1 docs (logged in each).

## Step 2 addendum — Board deepening (2026-06-20, prdmgr/user)
Board raised to **GitHub Issues + Milestones** maturity (see `../interaction/03-board-view.md`, deepened). Board-specific parts are inventoried in **`06-board.md`** (added to the detail-doc set): IssueListRow (StatusListRow variant), FilterQueryBar (extends FilterBar), SortControl, LabelChip, AssigneeAvatar (new shared Avatar primitive), MilestonePill / MilestoneProgressRow / MilestoneCard, IssueDetailHeader/Body, ActivityTimeline (shares TranscriptItem patterns), BulkActionToolbar, KanbanColumn/Card (desktop; consolidates the abstract `05` Kanban for the board), KeyboardFocus affordances.
- **Backward consistency held**: board reuses StatusChip / PanelFrame / SegmentedControl(List·Board·Milestones) / FilterBar / EmptyState·ErrorBanner·Skeleton / ApprovalCard(soft close gate) / Composer(comment box) / RouteLink; the Step 1 board doc was back-edited first (deepened + components-used + change log).
- **New shared primitives surfaced by board**: `AssigneeAvatar` (small Avatar) and `LabelChip` (label-colored pill, distinct from semantic StatusChip) — usable beyond board later; recorded here as shared.
- **New data entity flagged** (not a component decision): `BoardMilestone {id,title,due?,description?}` + `Task.milestoneId?` — additive/migration-safe, deferred to Step 3+/impl; raised as the one real new product surface (issue-panel.md had excluded milestones).

## Change / review log — Board addendum
- 2026-06-20 — Step 2 board deepening: added `06-board.md`; Step 1 `03-board-view.md` deepened first (GH Issues + Milestones); inventory + matrix extended.
