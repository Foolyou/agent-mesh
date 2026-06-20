# Step 4 — cross-review record (Steps 1 ↔ 2 ↔ 3 mutual consistency)

Pipeline `ui-design-pipeline` SKILL **Step 4**. Branch `task/ui-redesign-pipeline`. Reviews Step 3 (tokens + themed drafts, `tokens/`) against Step 1 (pages/interaction, `interaction/`) and Step 2 (component inventory, `components/`), back-edits every affected artifact so the three steps agree, and records what changed. **Docs-only.** Stops at the Step 4 gate (no Step 5).

## Scope & method
Read all 13 Step 1 docs, 7 Step 2 docs, 4 Step 3 docs. Cross-checked the five review axes the gate called out, plus a global grep sweep (`milestone`, theme naming, `/task/` routes, component names, label-token wording). Findings below; each fix is logged in the affected doc's own change log too.

## Axis 1 — Components/states in Step 3 themed drafts exist in Step 2 with consistent naming
**Result: consistent after one promotion.** Every component named in `tokens/03-themed-components.md` resolves to a Step 2 entry (StatusChip, Button/ConfirmButton, RouteLink, Badge, Input/Select/Textarea, Skeleton/Spinner/ProgressBar → `01`; PanelFrame, SegmentedControl, Modal/Drawer/Sheet, shell regions → `02`; StatusListRow, EmptyState, ErrorBanner, VersionLine → `03`; TranscriptItem family, Composer, ApprovalCard, Attachment/AuthedImage/Lightbox, Markdown/CodeBlock → `04`; Topology, ThemePicker, InstallProgress, DoctorTable, MeshBuilderForm, NotificationDrawer → `05`; IssueListRow, EpicGroupHeader, FilterQueryBar, SortControl, LabelChip, AssigneeAvatar, IssueDetailHeader/Body, ActivityTimeline, BulkActionToolbar, KanbanColumn/Card → `06`).
- **Fix (back-edit Step 2):** `AssigneeAvatar` + `LabelChip` were used by Step 3 as shared primitives but only specced under `06-board.md`. Promoted to atoms in `components/01-primitives.md` and added to the `00-inventory.md` matrix, so Step 3's "shared primitive" usage is backed in Step 2.

## Axis 2 — Components referenced by Step 1 pages are covered by Step 2 and Step 3
**Result: consistent.** Each Step 1 page doc's "Components used (Step 2)" list maps to existing Step 2 parts; all Step 2 parts get a token treatment in `tokens/03-themed-components.md`. Status-chip vocabulary in `interaction/00-index.md` maps to status tokens in Step 3 (`ready→ok`, `working→info`/`accent`, `blocked→bad`, `idle→off`, `done→good`, `attention→warn`).

## Axis 3 — Board correction consistent everywhere (no live milestone feature; Epic grouping only)
**Result: consistent after route/state/log alignment.** Global grep confirms `milestone` appears only in the 3 board docs and only as change-log / "benchmark-not-feature" clarification / the EpicGroupHeader "replaces removed milestone grouping" note — no product/component/route/token definition references a live milestone.
- **Fix (back-edit Step 1 index):** `interaction/00-index.md` still listed the board issue route as `/task/<id>` (ph3) and marked the board `permission` state as N/A. Aligned to `/mesh/<m>/board/issue/<N>` and set `permission`=✓ (the deepened board has a permission state). Added a Step 3+4 addendum (tokens cross-link + board-correction summary).

## Axis 4 — Token contract consistency (19-key, accent axis, label colors, component token usage)
**Result: consistent after one wording fix; no token value changes.**
- 19-key contract: Step 3 reuses the existing `THEME_KEYS` (no new/renamed tokens) → `contrast.ts` audits the palettes unmodified. Matches Step 1/2 references.
- Accent axis: `00-index.md`, `09-settings.md`, `05-domain.md` (ThemePicker "mode × accent 3×3"), `02-surfaces` SegmentedControl all name the same 3 modes (Dark·Slate / Light·Cool / Eye-care·Warm) × 3 accents (Teal / Ember / Azure) as Step 3.
- **Fix (back-edit Step 2):** `06-board.md` said LabelChip uses "Step-3 label color tokens", but Step 3 deliberately kept LabelChip colors **out of the 19-key contract** (they are per-label, data-driven → Step-5). Corrected `06-board.md` and `01-primitives.md` to state label colors are data-driven/outside the token contract, matching `tokens/03-themed-components.md`. Added the same clarification to `tokens/00-tokens.md`.

## Axis 5 — Change/review logs + cross-links maintained
**Result: consistent.** Every doc touched in Step 4 carries a Step-4 change-log line and the relevant cross-links (Step 1 index ↔ tokens; 03-lists task-row ↔ IssueListRow; FilterBar ↔ FilterQueryBar; 01-primitives ↔ 06-board). This record is linked from `interaction/00-index.md`, `components/00-inventory.md`, and `tokens/00-tokens.md`.

## Terminology note (not a defect)
"Issue" is the **GitHub-facing label** for a board **Task** (data model stays Epic→Task→Subtask per `issue-panel.md`). So `IssueListRow` = the `task-row` StatusListRow variant; both names refer to the same row. Cross-referenced in `03-lists-and-data.md` so the duality is explicit.

## Back-edits made (summary)
| file | change |
|---|---|
| `interaction/00-index.md` | route map `/task/<id>`→`/board/issue/<N>`; board `permission` state —→✓; Step 3+4 addendum |
| `components/01-primitives.md` | added Avatar (AssigneeAvatar) + LabelChip atoms; label-colors-outside-contract note |
| `components/00-inventory.md` | matrix: +Avatar +LabelChip rows; addendum points to `01`; label-token note |
| `components/02-surfaces-and-layout.md` | board issue detail = routable page, not drawer; "task detail"→"issue detail" |
| `components/03-lists-and-data.md` | task-row↔IssueListRow + FilterBar↔FilterQueryBar cross-links; issue=Task note |
| `components/06-board.md` | LabelChip colors = data-driven/outside 19-key contract (Step-5, not Step-3) |
| `tokens/00-tokens.md` | Step 4 cross-review note; label-colors-outside-contract clarification |

## Self-consistency confirmation
After the back-edits, Steps 1–3 are **mutually consistent**: every Step-3 component exists and is named consistently in Step 2; every Step-1-referenced component is covered by Steps 2 and 3; the board correction (no milestones, Epic grouping) holds across interaction/components/tokens; the token contract (19-key + accent axis + status mapping) is uniform and label colors are consistently scoped outside it. No contradiction required a product decision — all findings were docs cleanup.

## Change / review log
- 2026-06-20 — created (Step 4): cross-review of Steps 1–3; 7 docs back-edited for consistency; no token value changes; no `src/web` code changed. Stops at the Step 4 gate.
