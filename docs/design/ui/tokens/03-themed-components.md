# Step 3 — themed component drafts (Step 2 parts under the tokens)

Renders the Step 2 components (`../components/`) against the Step 3 tokens. Fidelity stays design-doc level: each part is annotated with **which token paints which surface**, so Step 5 builds them token-driven (Tailwind utilities → `var(--token)`) and a theme swap recolors them with zero per-component work. Per-mode visual notes follow.

Token shorthand: `bg`/`raise`/`inset` surfaces · `fg`/`dim`/`faint` text · `line`/`line-bright` borders · `ok`/`warn`/`bad`/`off`/`info` status · `accent` brand · `focus` ring · `sel-bg`/`sel-fg` selection.

## Atoms (`01-primitives.md`)
- **StatusChip** — fill/edge from the status token, label text AA on the chip. ready→`ok` · working→`accent` (or `info` for machine-busy) · attention→`warn` · blocked/error→`bad` · idle→`off` · done→`good`. *Dot* variant = `status-dot` family (≥3:1 non-text); *worded* variant = `status-text` family (≥4.5). Both proven in `02`.
- **Button / ConfirmButton** — default: `fg` on `raise`, border `line-bright`; primary: `accent` fill with AA label; danger: `bad`. Disabled = `fg-faint` (the hard 3.0 floor, never opacity). Focus = `focus` ring.
- **RouteLink** — `link` token (own token; defaults to `info`), AA on all surfaces (`02` status-text:link rows).
- **Badge (count)** — `bad` for unread/attention counts, `off` for neutral counts; text AA on the badge.
- **Input/Select/Textarea** — `inset` field, `line-bright` border, `fg` text, `focus` ring; placeholder `fg-faint`.
- **Skeleton / Spinner / ProgressBar** — `line`→`bg-raise` shimmer; progress fill `accent`, track `line`.

## Surfaces (`02-surfaces-and-layout.md`)
- **PanelFrame (Card)** — body on `raise`, hairline `line`, header text `fg`, meta `fg-dim`. Inset wells/code use `inset`.
- **SegmentedControl / Tabs** — track `inset`, selected segment `raise` + `fg`, unselected `fg-dim`, selected underline/edge `accent`; focus `focus`. (Board view switch `[List · Board]`, runtime `[运行态 · 看板]`.)
- **Topbar / LeftNav / RightContext** — `bg` shell, nav rows `fg-dim`→`fg` on hover (`sel-bg` wash), active route `accent` marker; dividers `line`.
- **Modal/Drawer/Sheet** — scrim = `fg` at low alpha over `bg`; panel `raise` + `line`.

## Lists & data (`03-lists-and-data.md`)
- **StatusListRow** (mesh rows, agent cards, harness/device/channel/notification rows) — leading StatusChip + `fg` title + `fg-dim` meta + trailing actions; hover = `sel-bg`/`sel-fg` wash (the `selection`/hover-wash pairs, ≥12:1); blocked tint uses `bad` left-border (`status-dot`).
- **EmptyState** — `fg-dim` headline, `fg-faint` body, `accent` CTA.
- **ErrorBanner / offline** — `bad` edge + `bad` text on its ~12% tint (`tinted-text:bad`, proven ≥4.5); retry = Button.
- **VersionLine** — `fg-dim` adapter, `fg-faint` body; stale = `warn`.

## Conversation (`04-conversation.md`)
- **TranscriptItem family** — MessageBubble: user `raise`, agent `bg`; Thought `fg-faint`; ToolCallCard status chip; PlanCard checklist; MailItem `info` edge; CompactItem `accent` marker; Divider `line`. Code via Markdown/CodeBlock on `inset` with syntax tokens (`info`=keyword, `good`=string, `fg-faint`=comment, `bad`/`warn`) — all AA on inset (`02` syntax rows).
- **Composer** — `inset` field, `line-bright` border, `fg` text, send = `accent` primary; disabled `fg-faint`; interrupt = `bad`.
- **ApprovalCard** — prominent: `warn`/`accent` edge, approve = primary (`accent`/`ok`), deny = `bad`; resolving = Spinner. Same part for runtime permission, assistant confirm, channel sender, device bootstrap.
- **AttachmentCard / AuthedImage / Lightbox** — card `raise`+`line`; Lightbox scrim over `bg`.

## Domain (`05-domain.md`)
- **TopologyGraph** (desktop) — nodes = StatusChip color + `fg` id + `bad` pending badge; edges `line-bright`, active edge `accent`; selected node `focus` ring.
- **ThemePicker** — mode SegmentedControl + accent SegmentedControl (swatches = the 9 accent values) + advanced custom editor with a **live `contrast.ts` readout** per role (recommended). Current selection = `accent` ring.
- **InstallProgress** — ProgressBar `accent`; log on `inset`; error `bad`.
- **DoctorTable / MeshBuilderForm / NotificationDrawer** — PanelFrame + StatusListRow + StatusChip; service-down prominent `bad`.

## Board (`06-board.md`, GitHub-Issues depth)
- **IssueListRow** — `#N` `fg-faint` · lifecycle StatusChip · `fg` title · AssigneeAvatar · LabelChips · priority · subtask progress (`accent` fill) · blocked `bad` badge · `fg-faint` updated-at; selected = `sel-bg`.
- **LabelChip** — label-colored pill (own label palette, Step-5 label color tokens; distinct from semantic StatusChip). On dark modes labels read on `raise`; on light modes ensure label colors stay AA — labels are user/data-driven so the editor should warn sub-AA (noted).
- **AssigneeAvatar** — initials on `off`/`accent` chip, `fg`/`sel-fg` text.
- **EpicGroupHeader** — `fg` epic title + `fg-faint` counts; collapsible chevron `fg-dim`.
- **FilterQueryBar / SortControl / BulkActionToolbar** — Inputs + Selects + Buttons on `raise`; active filter chips `accent`/`info`.
- **IssueDetailHeader/Body + ActivityTimeline** — PanelFrame; timeline reuses TranscriptItem rendering (lifecycle `info`, comment `fg`, mail `accent`).
- **KanbanColumn/Card** (desktop) — column header StatusChip + count Badge; card = condensed IssueListRow; over-drop highlight `accent`; perm-locked card `off`; focus `focus` (keyboard drag-alt).

```
draft — IssueListRow (Dark·Slate / Teal accent)
┌ raise ───────────────────────────────────────────────────────────────── line ┐
│ ☐  #12[faint]  ▸in_review[warn chip]  Add device-auth page[fg]  ◌@codex-1[off] │
│    🏷auth🏷ui[label]   ▣▣▢ 2/3[accent]   ⛔blocked[bad]              2d[faint]  │
└───────────────────────────────────────────────────────────────────────────────┘
 hover → sel-bg wash · focus → focus ring · selected → sel-bg fill
```

## Per-mode rendering notes
- **Dark·Slate** — high headroom everywhere (text ≥7.6); status hues pop on the slate field; accent (esp. Teal/Azure) is luminous, use restrained (selected-nav, thinking, progress), not as large fills. Default landing theme.
- **Light·Cool** — tighter margins (`text` 4.53, `border` 3.59); do **not** lighten `line-bright`/`fg-faint` further. Dark accents read as ink; Ember (`#b8460a`) is the warmest, good for a single brand touch.
- **Eye-care·Warm** — lowest luminance contrast by design (still AA); reduced blue. Sepia surfaces + warm inks; `warn` is deliberately dark (`#7a4c00`). Best for long sessions; accent stays an ink, not a glow.

## Artifacts
PNG token/swatch boards (full 19-token swatches per mode + the 9 accent chips, each labeled with its `02` ratio) are published to `$AGENT_MESH_ARTIFACTS` (not committed): see the report mail for filenames (`step3-token-board.png`).

## Change / review log
- 2026-06-20 — created (Step 3): every Step 2 component annotated to tokens; per-mode notes + board draft; PNG boards published as artifacts. No `src/web` code changed.
