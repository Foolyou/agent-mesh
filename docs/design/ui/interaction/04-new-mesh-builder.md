# New mesh builder — interaction (Step 1)

Route: `/mesh/new` (also used for edit: `/mesh/<m>/edit`). Inputs: ui-redesign.md §1.4; current `MeshBuilder`.

## Function
Define or edit a mesh: name, agents (id / harness / project / role), mail edges (topology), and an optional team charter. Produces a mesh definition the runtime can start.

## Core user actions
- Set mesh name; add/remove agents (pick harness + project + role router/member); draw/declare mail edges; write charter; save (define) or cancel.

## States
- **empty**: fresh form, one router row prefilled; save disabled until valid.
- **populated**: editing an existing mesh (fields hydrated).
- **busy**: saving → disabled save + spinner.
- **error**: validation (dup name, no router, bad edge) → inline field errors; save failed → banner + retry.

## Desktop
```
┌ new mesh ───────────────────────────────────────────────┐
│ name: [__________]                                        │
│ agents:  id        harness▾   project▾   role▾   [×]      │
│          router    claude     test_0     router          │
│          codex-1   codex      test_0     member  [+ add]  │
│ edges:   router→codex-1  codex-1→router   [+ edge]        │
│ charter: [ textarea ]                                      │
│                                   [Cancel]  [Save mesh]    │
└───────────────────────────────────────────────────────────┘
```
- Inline editable agent rows + edge list; live validation; charter optional.

## Mobile
- Single-column stacked form (name → agents accordion → edges → charter → save). Edge drawing simplified to a from/to picker list. Full builder is **secondary on mobile** (creation is rare on phone); supported but minimal.

## Mobile divergence
No canvas edge-drawing; from/to dropdown list instead. Considered low-frequency on mobile (spec §1.7 — deep management simplified).

## Open questions
None.

## Change / review log
- 2026-06-20 — created (Step 1).

## Components used (Step 2)
Parts on this page map to shared components in `../components/` (reuse matrix: `../components/00-inventory.md`). Canonical mappings: status surfaces → StatusChip; rows/cards → StatusListRow; framed surfaces → PanelFrame; section/view switches → SegmentedControl; empty/error/loading → EmptyState / ErrorBanner / Skeleton; navigation → RouteLink; inline approve/deny → ApprovalCard; conversation → TranscriptItem family + Composer.

## Change / review log — Step 2 addendum
- 2026-06-20 — Step 2 back-consistency: this page's one-off parts unified to shared components (StatusListRow / PanelFrame / SegmentedControl / ApprovalCard / Composer / EmptyState / ErrorBanner). See `../components/00-inventory.md` "Backward-consistency findings".
