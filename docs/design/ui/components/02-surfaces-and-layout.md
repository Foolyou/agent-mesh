# Step 2 components — 02 Surfaces & layout

## PanelFrame (Card)
- **Purpose**: the universal surface unit — a framed region (head + body) on `surface-raised` with `border` + radius. Every "panel"/"card"/"pane" in Step 1 is this.
- **Variants**: with/without head; head has title + ActionBar; nested (`surface-sunken` for code wells); flush vs padded; collapsible (right-context).
- **Surfaces**: all pages (left nav, main stage panels, right context, app surfaces, settings groups, modals' body).
- **Desktop/mobile**: same frame; mobile = full-width, less nesting.
- **Step-1 fix**: Step 1 used "panel"/"card"/"pane" interchangeably → all now = PanelFrame.

## ActionBar
- **Purpose**: the right-aligned control cluster in a PanelFrame head / page header (buttons + InfoIcon + overflow).
- **Variants**: page-level (topbar right), panel-level (head right), row-level (StatusListRow trailing).
- **Surfaces**: topbar, every panel head, list rows.
- **Reuse**: composes Button/ConfirmButton/InfoIcon/Badge.

## SegmentedControl / Tabs
- **Purpose**: switch between peer views/sections.
- **Variants**: 2-up switcher (`运行态|看板`, `list|kanban`, `中文|English`, `Dark|Light|Eye-care`), scrollable tab strip (conversation agent tabs), seg-tabs (RailLogs activity/mail/board/history). Selected/hover/disabled.
- **Surfaces**: shell view switcher, board, settings (theme/lang/default-view), runtime conversation tabs + rail.
- **Desktop/mobile**: mobile = bottom tabs (see BottomTabs) for top-level; in-page segmented stays.
- **Step-1 fix**: view switcher / board toggle / conversation tabs / rail seg-tabs unified to this control.

## MeshSelector
- **Purpose**: pick the active mesh (drives `/mesh/<m>` routes).
- **Variants/states**: dropdown (desktop topbar) / sheet (mobile); shows current + status chips; empty (no meshes) → "create".
- **Surfaces**: topbar (both devices), mobile mesh-picker sheet.
- **Reuse**: a Select specialized with StatusChip rows (StatusListRow variant in the menu).

## Modal / Drawer / Sheet (overlay)
- **Purpose**: overlay container for focused/secondary surfaces.
- **Variants**: center modal (new-mesh, install progress), right drawer (notifications), bottom sheet (mobile menus, mesh picker, filters). Scrim; dismiss; focus-trap.
- **Surfaces**: new-mesh, harness install, notifications drawer, mobile "更多"/pickers. (Board **issue detail** is a routable page `/board/issue/<N>`, not a drawer — see Note + `../interaction/03-board-view.md`.)
- **Note**: several Step-1 app surfaces (harness/channels/doctor/assistant) become routable **pages**; whether they also present as overlay vs full page is a Step-3/5 styling choice — the container component is the same.

## Shell regions (composed)
- **Topbar** — brand + connection StatusChip + MeshSelector + SegmentedControl(view switcher) + ActionBar(🔔 Badge / 管理▾ / 设置▾). Mobile: slim (brand + dot + selector).
- **LeftNav** — collapsible list of mesh StatusListRows + `+ New mesh` Button. Mobile: becomes MeshSelector sheet (no rail).
- **RightContext** — collapsible PanelFrame stack (on-demand topology/activity/mail). Desktop-only.
- **BottomTabs** (mobile) — `运行态 · 看板 · 更多`; the mobile top-level navigation (replaces topbar switcher + side rail).
- **Reuse**: all composed from primitives + PanelFrame/SegmentedControl/StatusListRow.

## Change / review log
- 2026-06-20 — created (Step 2). PanelFrame + SegmentedControl unifications back-applied to Step 1 (logged there).
- 2026-06-20 — Step 4 cross-review: board issue detail clarified as a routable page (`/board/issue/<N>`), not a drawer; "task detail" wording → "issue detail".
- 2026-06-20 — Step 4 re-review (v2 tokens): PanelFrame surfaces/border → `surface-raised`/`surface-sunken`/`border` (v2 semantic). See `../04-cross-review.md`.
