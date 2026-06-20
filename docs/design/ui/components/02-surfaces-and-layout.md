# Step 2 components — 02 Surfaces & layout

## PanelFrame (Card)
- **Purpose**: the universal surface unit — a framed region (head + body) on `bg-raise` with `line` border + radius. Every "panel"/"card"/"pane" in Step 1 is this.
- **Variants**: with/without head; head has title + ActionBar; nested (bg-inset for code wells); flush vs padded; collapsible (right-context).
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
- **Variants**: center modal (new-mesh, install progress), right drawer (notifications, task detail desktop), bottom sheet (mobile menus, mesh picker, filters). Scrim; dismiss; focus-trap.
- **Surfaces**: new-mesh, harness install, notifications drawer, board task detail, mobile "更多"/pickers.
- **Note**: several Step-1 app surfaces (harness/channels/doctor/assistant) become routable **pages**; whether they also present as overlay vs full page is a Step-3/5 styling choice — the container component is the same.

## Shell regions (composed)
- **Topbar** — brand + connection StatusChip + MeshSelector + SegmentedControl(view switcher) + ActionBar(🔔 Badge / 管理▾ / 设置▾). Mobile: slim (brand + dot + selector).
- **LeftNav** — collapsible list of mesh StatusListRows + `+ New mesh` Button. Mobile: becomes MeshSelector sheet (no rail).
- **RightContext** — collapsible PanelFrame stack (on-demand topology/activity/mail). Desktop-only.
- **BottomTabs** (mobile) — `运行态 · 看板 · 更多`; the mobile top-level navigation (replaces topbar switcher + side rail).
- **Reuse**: all composed from primitives + PanelFrame/SegmentedControl/StatusListRow.

## Change / review log
- 2026-06-20 — created (Step 2). PanelFrame + SegmentedControl unifications back-applied to Step 1 (logged there).
