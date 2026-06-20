# Step 3 token v2 — themed component drafts (Step 2 parts under semantic tokens)

**v2 (supersedes v1).** Renders the Step 2 components (`../components/`) against the **v2 semantic tokens** (`00-tokens.md`, `01-palettes.md`). Each part is annotated with the **semantic token** that paints each surface, so Step 5 builds them token-driven (Tailwind utilities → `var(--<semantic>)`) and a mode/accent swap recolors them with zero per-component work. Components reference **only** semantic tokens (never raw scales).

Semantic shorthand: `surface`/`surface-raised`/`surface-sunken` · `text-primary`/`-secondary`/`-muted`/`-disabled` · `border`/`border-strong` · `success`/`warning`/`danger`/`idle`/`info`/`link` · `accent`(+`accent-hover`/`-active`/`-subtle`/`on-accent`) · `focus-ring` · `selected`/`text-on-selected` · `hover`/`active`.

## Atoms (`01-primitives.md`)
- **StatusChip** — fill/edge from the status token, label AA on the chip. ready→`success` · working→`accent` (or `info` for machine-busy) · attention→`warning` · blocked/error→`danger` · idle→`idle` · done→`success`. *Dot* variant = `status-dot` family (≥3); *worded* variant = `status-text` (≥4.5). Proven in `02`.
- **Button / ConfirmButton** — default: `text-primary` on `surface-raised`, `border-strong` edge; primary: `accent` fill + `on-accent` label; danger: `danger`. Disabled: `text-disabled` (3.0 floor, never opacity). Hover: `accent-hover`/`hover` wash; pressed: `accent-active`/`active`. Focus: `focus-ring`.
- **RouteLink** — `link` token, AA on all surfaces (`02` status-text:link).
- **Badge (count)** — `danger` for unread/attention, `idle` for neutral; text AA on the badge.
- **Input/Select/Textarea** — `surface-sunken` field, `border-strong` edge, `text-primary` text, `focus-ring`; placeholder `text-muted`.
- **Avatar (AssigneeAvatar)** — disc tone `idle`/`accent`, initials `text-primary`/`on-accent`.
- **LabelChip** — label-colored pill; **label colors are data-driven and OUTSIDE the semantic token contract** (per-label values, Step-5 handling), distinct from semantic StatusChip; the editor warns sub-AA labels (consistent with `../components/06-board.md` + Step 4).
- **Skeleton / Spinner / ProgressBar** — `border`→`surface-raised` shimmer; progress fill `accent`, track `border`.

## Surfaces (`02-surfaces-and-layout.md`)
- **PanelFrame (Card)** — body on `surface-raised`, hairline `border`, header `text-primary`, meta `text-secondary`. Code/inset wells use `surface-sunken`.
- **SegmentedControl / Tabs** — track `surface-sunken`, selected segment `surface-raised` + `text-primary`, unselected `text-secondary`, selected edge `accent`; `focus-ring`. (Board `[List · Board]`, runtime `[运行态 · 看板]`.)
- **Topbar / LeftNav / RightContext** — `surface` shell, nav rows `text-secondary`→`text-primary` on `hover` wash, active route = `selected` (`accent-subtle`) + `accent` marker; dividers `border`.
- **Modal/Drawer/Sheet** — scrim `surface-overlay`; panel `surface-raised` + `border`.

## Lists & data (`03-lists-and-data.md`)
- **StatusListRow** (mesh rows, agent cards, harness/device/channel/notification rows) — leading StatusChip + `text-primary` title + `text-secondary` meta + trailing actions; `hover` wash; selected = `selected` + `text-on-selected`; blocked = `danger` left-border (`status-dot`).
- **EmptyState** — `text-secondary` headline, `text-muted` body, `accent` CTA.
- **ErrorBanner / offline** — `danger` edge + `danger` text on its ~12% tint (`tinted-text`, ≥4.5 proven); retry = Button.
- **VersionLine** — `text-secondary` adapter, `text-muted` body; stale = `warning`.

## Conversation (`04-conversation.md`)
- **TranscriptItem family** — MessageBubble: user `surface-raised`, agent `surface`; Thought `text-muted`; ToolCallCard status chip; PlanCard checklist; MailItem `info` edge; CompactItem `accent` marker; Divider `border`. Code via Markdown/CodeBlock on `surface-sunken` with syntax tokens (`syntax-keyword`=info, `syntax-string`=success, `syntax-comment`=text-muted) — all AA on sunken (`02` syntax rows).
- **Composer** — `surface-sunken` field, `border-strong` edge, `text-primary` text, send = `accent` primary (+`on-accent`); disabled `text-disabled`; interrupt = `danger`.
- **ApprovalCard** — prominent: `warning`/`accent` edge, approve = primary (`accent`/`success` + `on-accent`), deny = `danger`; resolving = Spinner. Same part for runtime permission, assistant confirm, channel sender, device bootstrap.
- **AttachmentCard / AuthedImage / Lightbox** — card `surface-raised`+`border`; Lightbox scrim = `surface-overlay`.

## Domain (`05-domain.md`)
- **TopologyGraph** (desktop) — nodes = StatusChip color + `text-primary` id + `danger` pending badge; edges `border-strong`, active edge `accent`; selected node `focus-ring`.
- **ThemePicker** — **mode** SegmentedControl + **accent** SegmentedControl (independent axes; swatches = the 3 accent ramps) + advanced custom editor with a **live `contrast.ts` readout** per semantic pair. Current selection = `accent` ring.
- **InstallProgress** — ProgressBar `accent`; log on `surface-sunken`; error `danger`.
- **DoctorTable / MeshBuilderForm / NotificationDrawer** — PanelFrame + StatusListRow + StatusChip; service-down prominent `danger`.

## Board (`06-board.md`, GitHub-Issues depth)
- **IssueListRow** — `#N` `text-muted` · lifecycle StatusChip · `text-primary` title · AssigneeAvatar · LabelChips · priority · subtask progress (`accent` fill) · blocked `danger` badge · `text-muted` updated-at; selected = `selected`.
- **LabelChip** — data-driven label colors (outside the semantic contract; see Atoms above + `06-board.md`).
- **AssigneeAvatar** — `idle`/`accent` disc, `text-primary`/`on-accent` initials.
- **EpicGroupHeader** — `text-primary` epic title + `text-muted` counts; chevron `text-secondary`.
- **FilterQueryBar / SortControl / BulkActionToolbar** — Inputs + Selects + Buttons on `surface-raised`; active filter chips `accent`/`info`.
- **IssueDetailHeader/Body + ActivityTimeline** — PanelFrame; timeline reuses TranscriptItem rendering (lifecycle `info`, comment `text-primary`, mail `accent`).
- **KanbanColumn/Card** (desktop) — column header StatusChip + count Badge; card = condensed IssueListRow; over-drop highlight `accent`; perm-locked card `idle`; `focus-ring` (keyboard drag-alt).

```
draft — IssueListRow (Dark·Slate × Signal Teal)
┌ surface-raised ─────────────────────────────────────────────── border ┐
│ ☐ #12[muted] ▸in_review[warning chip] Add device-auth page[text-primary] ◌@codex-1[idle] │
│   🏷auth🏷ui[label]  ▣▣▢ 2/3[accent]  ⛔blocked[danger]            2d[muted] │
└─────────────────────────────────────────────────────────────────────────┘
 hover → hover wash · focus → focus-ring · selected → selected fill (accent-subtle)
```

## Per-mode rendering notes (v2)
- **Dark·Slate** — huge headroom (`text-primary` ≥12.95, AAA). Status hues at the light end (stop 400) pop on the slate field; `accent` (esp. Teal/Azure) is luminous — use restrained (selected-nav, thinking, progress, small fills), with `on-accent` = near-black. Default landing theme.
- **Light·Cool** — status/accent at dark stops (700–800) read as ink; `on-accent` = white. Tightest pairs are floor families (`text-disabled`/sunken 3.24, `accent-text` ~4.6) — do **not** lighten `border-strong`/`text-muted`/accent further.
- **Eye-care·Warm** — warm sepia, reduced blue, gentler luminance — still full AA/AAA. Status/accent at 700–800 (Ember at 800); `on-accent` = white. Best for long sessions; `accent` stays an ink, not a glow.

## Artifacts
PNG sample boards are **the next checkpoint** (not generated here, per the pass plan): three per-mode boards `v2-sample-dark-slate.png` / `v2-sample-light-cool.png` / `v2-sample-eye-care-warm.png` (each ≤~1500px, all 3 accents inside) + raw-scale/old↔new swatch boards, published to `$AGENT_MESH_ARTIFACTS` (not committed). See `05-v2-pass-plan.md`.

## Change / review log
- 2026-06-20 — created (Step 3 v1): components annotated to the 19-key tokens.
- 2026-06-20 — **v2 (supersedes v1)**: re-annotated every Step 2 component (incl. board + Avatar/LabelChip) to the v2 **semantic** tokens; added interaction-state tokens (`hover`/`active`/`selected`/`on-accent`), label-colors-outside-contract note (consistent with Step 4), v2 per-mode notes (AAA primary, per-mode accent stops), and moved PNG boards to the next checkpoint. No `src/web` code changed.
