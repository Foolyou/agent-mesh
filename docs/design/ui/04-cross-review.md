# Step 4 — cross-review record (Steps 1 ↔ 2 ↔ 3 mutual consistency)

Pipeline `ui-design-pipeline` SKILL **Step 4**. Branch `task/ui-redesign-pipeline`. Reviews Step 3 (tokens + themed drafts, `tokens/`) against Step 1 (pages/interaction, `interaction/`) and Step 2 (component inventory, `components/`), back-edits every affected artifact so the three steps agree, and records what changed. **Docs-only.** Stops at the Step 4 gate (no Step 5).

## Scope & method
Read all 13 Step 1 docs, 7 Step 2 docs, 4 Step 3 docs. Cross-checked the five review axes the gate called out, plus a global grep sweep (`milestone`, theme naming, `/task/` routes, component names, label-token wording). Findings below; each fix is logged in the affected doc's own change log too.

## Axis 1 — Components/states in Step 3 themed drafts exist in Step 2 with consistent naming
**Result: consistent after one promotion.** Every component named in `tokens/03-themed-components.md` resolves to a Step 2 entry (StatusChip, Button/ConfirmButton, RouteLink, Badge, Input/Select/Textarea, Skeleton/Spinner/ProgressBar → `01`; PanelFrame, SegmentedControl, Modal/Drawer/Sheet, shell regions → `02`; StatusListRow, EmptyState, ErrorBanner, VersionLine → `03`; TranscriptItem family, Composer, ApprovalCard, Attachment/AuthedImage/Lightbox, Markdown/CodeBlock → `04`; Topology, ThemePicker, InstallProgress, DoctorTable, MeshBuilderForm, NotificationDrawer → `05`; IssueListRow, EpicGroupHeader, FilterQueryBar, SortControl, LabelChip, AssigneeAvatar, IssueDetailHeader/Body, ActivityTimeline, BulkActionToolbar, KanbanColumn/Card → `06`).
- **Fix (back-edit Step 2):** `AssigneeAvatar` + `LabelChip` were used by Step 3 as shared primitives but only specced under `06-board.md`. Promoted to atoms in `components/01-primitives.md` and added to the `00-inventory.md` matrix, so Step 3's "shared primitive" usage is backed in Step 2.

## Axis 2 — Components referenced by Step 1 pages are covered by Step 2 and Step 3
**Result: consistent.** Each Step 1 page doc's "Components used (Step 2)" list maps to existing Step 2 parts; all Step 2 parts get a token treatment in `tokens/03-themed-components.md`. Status-chip vocabulary in `interaction/00-index.md` maps to v2 status tokens (`ready→success`, `working→info`/`accent`, `blocked→danger`, `idle→idle`, `done→success`, `attention→warning`).

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

## Self-consistency confirmation (v1 pass)
After the v1 back-edits, Steps 1–3 were **mutually consistent** under the v1 single-layer 19-key token model.

---

# Step 4 re-review — v2 token system (2026-06-20)
After the approved Step-3 **v2 token rework** (two-layer raw scales + semantic tokens, orthogonal mode×accent axes, AAA/stronger contrast — `tokens/00`–`03` + `04`/`05`), Steps 1–3 were re-reviewed against the v2 semantic system.

## v2 axes re-checked
1. **No Step 1/2 doc still names v1 tokens.** Swept `interaction/` + `components/` for every v1 token (`bg`/`bg-raise`/`bg-inset`/`line`/`line-bright`/`fg`/`fg-dim`/`fg-faint`/`ok`/`warn`/`bad`/`off`/`good`/`sel-bg`/`sel-fg` + in-paren color hints). All references back-edited to v2 semantic names; final grep = zero residual. (`info`/`link`/`accent` are unchanged v2 tokens and stay.)
2. **Status vocabulary aligned.** `interaction/00-index.md` + `components/01-primitives.md` StatusChip set now reads `ready→success · working→info/accent · blocked→danger · idle→idle · done→success · attention→warning`.
3. **Surfaces/borders aligned.** PanelFrame (`02-surfaces`, `00-inventory`) now uses `surface-raised`/`surface-sunken`/`border`; Button uses `accent`+`on-accent` / `border-strong` / `danger` / `text-disabled`; Avatar uses `idle`/`accent` + `text-primary`/`on-accent`.
4. **Step 3 already v2.** `tokens/00`–`03` are the v2 two-layer system; artifacts (`v2-sample-*`, `v2-raw-scales`, `v2-semantic-swatches`, `v2-oldnew-comparison`) match the values. Board correction (no milestones, Epic grouping) still holds.
5. **No contradictions needing a product decision** — all findings were token-name cleanup.

## v2 back-edits made
| file | change |
|---|---|
| `interaction/00-index.md` | status vocab + Step-3 mapping → v2 names (success/danger/idle/warning) |
| `components/00-inventory.md` | PanelFrame unification note → `surface-raised`/`border` |
| `components/01-primitives.md` | StatusChip set, Badge, Button, Avatar → v2 semantic tokens |
| `components/02-surfaces-and-layout.md` | PanelFrame surfaces/border → `surface-raised`/`surface-sunken`/`border` |
| `04-cross-review.md` | Axis-2 status mapping → v2 names; this v2 re-review section |

## Self-consistency confirmation (v2)
Steps 1–3 are **mutually consistent under the v2 two-layer semantic token system**: Step 1/2 docs reference only v2 semantic token names (or kept tokens info/link/accent), the status vocabulary matches `tokens/`, and components map cleanly to the v2 semantic catalogue. Docs-only; no `src/web`/`contrast.ts`/build changes.

---

# Step 4 re-review — v2.1 status tokens (2026-06-20)
After the v2.1 follow-up (status `*-subtle` + `on-*` tokens), Steps 1–3 were re-reviewed for the three patterns the gate called out: component-side status tinting, unnamed filled-status foregrounds, and old "AA on chip" wording.

## Findings & back-edits
1. **Component-side status tinting** — only the legacy ad-hoc tints remained: `02-aa-evidence.md`'s `tinted:danger (12% over sunken)` / `tinted:warning (10% over sunken)` evidence rows. Annotated both as **legacy, superseded by the named `danger-subtle`/`warning-subtle` tokens** (the canonical status tint is now `*-subtle`). `03-themed-components.md` ErrorBanner already references `danger-subtle` (v2.1 checkpoint 1).
2. **Unnamed filled-status foregrounds** — `03-themed-components.md` already routes filled-status text through `on-<status>` (Button danger, Composer interrupt, ApprovalCard deny, StatusChip filled, Badge urgent). For Step-2↔3 parity, added the *soft*/*filled* render variants + `on-<status>` to `components/01-primitives.md` StatusChip and `on-danger` to Badge.
3. **"AA on chip" wording** — none remained (removed in the v2 re-review; StatusChip now describes dot/worded/soft/filled variants, not "label AA on the chip").
4. **Stale wording** — `03-themed-components.md` change log still said "Sample-board PNGs to be re-rendered…"; corrected to past tense + a v2.1-artifacts log line (the re-render was done in checkpoint 2).

## v2.1 back-edits made
| file | change |
|---|---|
| `components/01-primitives.md` | StatusChip soft/filled variants + `on-<status>`; Badge urgent → `danger` fill + `on-danger` |
| `tokens/02-aa-evidence.md` | legacy `tinted:danger`/`tinted:warning` rows annotated as superseded by `danger-subtle`/`warning-subtle` |
| `tokens/03-themed-components.md` | change-log stale "to be re-rendered" wording fixed + v2.1-artifacts log line |
| `04-cross-review.md` | this v2.1 re-review section |

## Self-consistency confirmation (v2.1)
Steps 1–3 are **mutually consistent under v2.1**: the 8 status tokens (`*-subtle` + `on-*`) are mode-driven/accent-independent (`01`, `02`), components reference named `*-subtle` tints and `on-<status>` filled foregrounds (`01-primitives`, `03`), no component-side tint formula or unnamed filled foreground or "AA on chip" wording remains, and the artifacts (`v2-status-tokens.png` + re-rendered sample boards) match. Docs-only; no `src/web`/`contrast.ts`/build changes.

## Change / review log
- 2026-06-20 — created (Step 4 v1): cross-review of Steps 1–3 under v1 tokens; 7 docs back-edited.
- 2026-06-20 — **Step 4 re-review (v2)**: re-checked Steps 1–3 against the v2 two-layer token system; back-edited `00-index`, `00-inventory`, `01-primitives`, `02-surfaces`, and this doc from v1 token names → v2 semantic names; residual-v1-token grep = zero. Docs-only.
- 2026-06-20 — **Step 4 re-review (v2.1)**: re-checked for component-side tinting / unnamed filled-status fg / "AA on chip"; annotated legacy tint evidence rows as superseded by `*-subtle`, added StatusChip soft/filled + Badge `on-danger` to `01-primitives`, fixed stale re-render wording in `03`. Docs-only.
