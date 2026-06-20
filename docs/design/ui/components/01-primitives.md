# Step 2 components — 01 Primitives (atoms)

Low-fi part specs. Format: purpose · variants/states · surfaces · desktop/mobile · reuse. Tokens are Step 3.

## StatusChip (signature)
- **Purpose**: at-a-glance status as `dot + icon + label` pill. The connective tissue across the app.
- **Variants** (canonical 6, Step1 `00-index`): `ready`(success ●) `working`(info ▶) `blocked`(danger ■) `idle`(idle ○) `done`(success ✓) `attention`(warning !) — v2 semantic token names. Sizes: inline / compact (dot-only on dense rows). Optional count suffix.
- **Surfaces**: shell connection, mesh rows, topology nodes, agent cards, board task status, harness status, channels, doctor findings, device status.
- **Desktop/mobile**: same; compact (dot-only) where space is tight (mobile dense lists).
- **Reuse**: embedded in StatusListRow, topology node, board card. Color from semantic tokens (Step 3).

## Dot
- **Purpose**: bare status dot (chip without label/icon) for ultra-dense or decorative use.
- **Variants**: the 6 status colors. **Reuse**: inside StatusChip; standalone in tab labels.

## Badge (count)
- **Purpose**: small numeric/notification count.
- **Variants**: number / dot-only; tones: unread(`accent` or `info`), urgent(`danger`).
- **Surfaces**: 🔔 unread, pending-approval red count (topology node + overview), board task count, harness "update" indicator, channel pending count.
- **Reuse**: overlaid on Button/icon/RouteLink/StatusListRow.

## Button
- **Purpose**: action trigger.
- **Variants**: `primary`(`accent` fill + `on-accent`) · `ghost`/secondary(`border-strong` edge) · `danger`(`danger`) · `link-style`; sizes sm/md; states default/hover(`hover`)/active(`active`)/disabled(`text-disabled`)/busy(spinner). Icon-only variant.
- **Surfaces**: every page (Send, Start/Stop, Reload, install/update, approve, save…).
- **Desktop/mobile**: mobile = larger tap targets, icon-only collapses to labeled where room.

## ConfirmButton
- **Purpose**: two-step confirm for destructive/irreversible actions (no native dialog).
- **Variants**: armed/confirm states; danger tone; with confirm label text.
- **Surfaces**: force-restart agent (runtime/harness), delete mesh, dangerous publish, revoke device/sender.
- **Reuse**: a Button wrapper; pairs with ApprovalCard semantics.

## RouteLink
- **Purpose**: a real `<a href>` that SPA-navigates on unmodified same-origin left-click, native otherwise (open-new-tab works). Foundation of the route map (Step1 §3.2).
- **Variants**: nav-row link, switcher segment, inline link, artifact link; active/current state.
- **Surfaces**: left nav rows, view switcher, topbar app entries, artifact cards/links, board task links.
- **Reuse**: wraps StatusListRow, SegmentedControl segments, AttachmentCard.

## Input / Textarea / Select (dropdown)
- **Purpose**: form fields.
- **Variants/states**: text input, textarea (composer/charter), select/dropdown (mesh selector, harness/project/role, filters, language); default/focus/error/disabled.
- **Surfaces**: new-mesh, settings, channels, filters, composer, mesh selector.
- **Desktop/mobile**: native select on mobile; dropdowns become sheets where rich.

## InfoIcon / Tooltip
- **Purpose**: ⓘ revealing a description on hover/focus (declutters dense headers).
- **Surfaces**: panel heads (topology/activity/mailbox), harness rows, settings, doctor.
- **Reuse**: lives in ActionBar/PanelFrame head.

## Avatar (AssigneeAvatar)
- **Purpose**: small identity chip — an agent/human id rendered as initials (or image) on a tinted disc; "unassigned" placeholder.
- **Variants**: single / stacked (rare) / unassigned. Sizes: inline (rows) / sm (kanban card, bulk).
- **Surfaces**: board issue row / detail / kanban card / bulk-assign (today); reusable wherever an actor identity shows later.
- **Reuse**: surfaced as a shared primitive in Step 2 (board) and used by Step 3 themed drafts; disc tone = `idle`/`accent`, text AA (`text-primary`/`on-accent`). Board specialization documented in `06-board.md`.

## LabelChip
- **Purpose**: a colored data label (GitHub-style), distinct from the semantic StatusChip.
- **Variants**: read chip / removable (editor) / filter-active.
- **Surfaces**: board issue row / detail meta / filter chips (today); reusable for any tag-like data.
- **Reuse**: shared primitive. **Label colors are data-driven and live OUTSIDE the 19-key token contract** (per-label values, Step-5 handling) — not theme tokens; sub-AA label colors should be warned in the editor. Board specialization in `06-board.md`.

## Skeleton
- **Purpose**: loading placeholder (shape of forthcoming content).
- **Variants**: line, block, row, card, table.
- **Surfaces**: every page's `loading` state.

## Spinner / ProgressBar
- **Purpose**: indeterminate (spinner) / determinate (bar) busy feedback.
- **Surfaces**: busy states everywhere; ProgressBar specifically for harness InstallProgress.

## Change / review log
- 2026-06-20 — created (Step 2).
- 2026-06-20 — Step 4 cross-review: promoted **Avatar (AssigneeAvatar)** + **LabelChip** to shared atoms here (they were declared shared primitives in `00-inventory.md` and used by Step 3 themed drafts, but only specced under `06-board.md`). Recorded that LabelChip colors are data-driven, outside the 19-key token contract.
- 2026-06-20 — Step 4 re-review (v2 tokens): StatusChip set, Badge, Button, Avatar re-annotated from v1 token names to v2 semantic tokens (`success`/`danger`/`idle`/`warning`, `accent`+`on-accent`, `border-strong`, `text-disabled`, `text-primary`). See `../04-cross-review.md`.
