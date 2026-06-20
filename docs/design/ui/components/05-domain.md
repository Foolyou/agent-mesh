# Step 2 components — 05 Domain widgets

Surface-specific widgets (not broadly reused, but documented for completeness). Desktop-only ones are explicit.

## TopologyGraph (desktop)
- **Purpose**: zoomable graph of agents (nodes) + mail edges; the runtime global overview. Node = StatusChip + id + pending Badge; click → focus transcript.
- **Variants/states**: live/stopped; node selected/flashing; edge active; expand (⤢) overlay.
- **Surfaces**: runtime (desktop). **Mobile**: replaced by AgentCard list (StatusListRow) — **topology is desktop-only by design** (spec §1.7).
- **Reuse**: nodes reuse StatusChip/Badge; otherwise bespoke canvas.

## KanbanColumn / KanbanCard (desktop)
- **Purpose**: board kanban — columns by status, draggable cards.
- **Variants/states**: column(empty/populated); card(task summary = StatusListRow content); drag/drop.
- **Surfaces**: board (desktop). **Mobile**: simplified to list + status filter (no drag) — desktop-only drag (spec §1.6).
- **Reuse**: card content = task StatusListRow; column header = StatusChip + count Badge.

## InstallProgress
- **Purpose**: live harness install/update feedback — step + ProgressBar + streamed log + retry.
- **States**: running / done / error / interrupted(retry).
- **Surfaces**: harnesses. **Mobile**: collapses log into a sheet. **Reuse**: ProgressBar + Button + PanelFrame.

## ThemePicker
- **Purpose**: pick mode × accent (3×3) + custom palette; instant runtime swap.
- **Variants/states**: mode SegmentedControl + accent SegmentedControl + custom-palette editor (advanced; simplified on mobile); current selection reflected.
- **Surfaces**: settings. **Reuse**: SegmentedControl + swatches; values = Step-3 tokens.

## MeshBuilderForm (agent rows + edge editor)
- **Purpose**: define/edit a mesh — name, agent rows, edges, charter.
- **Variants/states**: create/edit; valid/invalid(field errors); busy(saving).
- **Surfaces**: new-mesh. **Mobile**: edge canvas → from/to picker list (builder secondary on mobile).
- **Reuse**: Input/Select + StatusListRow(agent rows) + Textarea(charter) + Button.

## DoctorTable
- **Purpose**: daemon list + doctor findings.
- **Variants/states**: loading/populated/error/offline(service-down prominent); finding chips ok/warn/bad.
- **Surfaces**: doctor. **Mobile**: read-only summary. **Reuse**: PanelFrame + StatusListRow(daemon) + StatusChip(findings) + StatTile.

## NotificationDrawer
- **Purpose**: the 🔔 surface — list of NotificationItems (StatusListRow variant) + mark-read + history.
- **Surfaces**: notifications. **Desktop**: right Drawer; **Mobile**: full-screen list. **Reuse**: Drawer + StatusListRow + FilterBar + Badge.

## Change / review log
- 2026-06-20 — created (Step 2).
