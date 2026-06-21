# App shell — interaction (Step 1)

Routes: frame for all; `/` = default landing → runtime of default mesh. Inputs: ui-redesign.md §1.4/§1.7, phase1.md §2/§3.2.

## Function
The global chrome that hosts every view: identity + connection, mesh selection, the runtime⇄board view switcher, and the app-level entries (notifications, management, settings). Establishes the IA so the user always knows where they are and what's primary.

## Core user actions
- Pick the active mesh (selector); switch view (运行态 ⇄ 看板); open an app surface (🔔 / 管理▾ / 设置▾); collapse the left nav; (mobile) switch bottom tab.

## States
- **empty**: no meshes defined → main stage shows a "create your first mesh" empty state with a primary `+ New mesh` (→ `/mesh/new`); left nav shows the empty hint.
- **loading**: initial snapshot in flight → skeleton topbar + nav; main stage skeleton.
- **populated**: mesh selected, view rendered.
- **error**: snapshot/load failed → inline banner in main stage + retry; chrome still usable.
- **offline**: WS/connection lost → connection chip flips to `offline`(bad), a thin reconnecting banner; views show last-known + "reconnecting".
- **unauthorized**: device-auth not satisfied → entire app replaced by device-auth page (doc 12).

## Desktop
```
┌ topbar ───────────────────────────────────────────────────────────────────┐
│ ◈ Mesh  ●connected │ mesh: dev-mesh   [运行态|看板] │ 🔔3  管理▾  设置▾        │
├──────────────┬──────────────────────────────────────────┬──────────────────┤
│ left nav     │ main stage (runtime A / board C)          │ right context    │
│ mesh list    │ (largest; per active view)                │ (on-demand,      │
│ + status chip│                                           │  collapsible)    │
│ [+ New mesh] │                                           │                  │
│ (collapsible)│                                           │                  │
└──────────────┴──────────────────────────────────────────┴──────────────────┘
```
- Topbar left = brand + connection chip; center = **adaptive mesh control** + view switcher (real `<a>`: `/mesh/<m>` vs `/mesh/<m>/board`); right = 🔔(unread count) · 管理▾(assistant/harnesses/channels/doctor) · 设置▾(theme/lang/auth/devices).
- **Mesh control is adaptive, not a permanent duplicate dropdown.** The **left nav is the primary mesh switcher** when it is visible. So: left nav **expanded** → topbar shows the current mesh as a **non-interactive label/breadcrumb** (`mesh: dev-mesh`); left nav **collapsed** (list hidden) → topbar shows a `mesh ▾` **select** as the fallback switcher. Mobile (no left nav) → topbar always keeps the `mesh ▾` select.
- Left nav = mesh rows (each a real `<a href="/mesh/<m>">` with status chip); `+ New mesh`. It is the canonical mesh switcher + status overview. **Collapsing hides the nav entirely** (no thin rail, no status dots) — only a small floating **expand** button at the left edge restores it, and the main stage takes the freed width.
- Right context collapses; content owned by the active view (doc 02/03).

## Mobile
```
┌ topbar: ◈ Mesh  ●  mesh▾ ───────────────┐
│           (active view, full width)      │
│                                          │
├──────────────────────────────────────────┤
│  [运行态]      [看板]      [更多]          │  ← bottom tabs
└──────────────────────────────────────────┘
```
- Bottom tabs `运行态 · 看板 · 更多`; "更多" sheet = 管理/设置/🔔.
- Topbar slim: brand + connection dot + mesh selector only; view switch is the bottom tabs.
- Left nav becomes a mesh-picker sheet from the mesh selector (no persistent side rail).

## Mobile divergence
No persistent side rail / right context (space); view switch via bottom tabs not topbar segment; app-level surfaces consolidated into "更多". Per spec §1.7 (touch reflow, not folded desktop).

## Open questions
None.

## Change / review log
- 2026-06-20 — created (Step 1).

## Components used (Step 2)
Parts on this page map to shared components in `../components/` (reuse matrix: `../components/00-inventory.md`). Canonical mappings: status surfaces → StatusChip; rows/cards → StatusListRow; framed surfaces → PanelFrame; section/view switches → SegmentedControl; empty/error/loading → EmptyState / ErrorBanner / Skeleton; navigation → RouteLink; inline approve/deny → ApprovalCard; conversation → TranscriptItem family + Composer.

## Change / review log — Step 2 addendum
- 2026-06-20 — Step 2 back-consistency: this page's one-off parts unified to shared components (StatusListRow / PanelFrame / SegmentedControl / ApprovalCard / Composer / EmptyState / ErrorBanner). See `../components/00-inventory.md` "Backward-consistency findings".

## Change / review log — Step 6 addendum
- 2026-06-21 — prdmgr/user revision (shell mockup ckpt): topbar mesh control is **adaptive**, with the left nav as the primary desktop mesh switcher — expanded nav → topbar mesh **label**, collapsed nav → topbar mesh **select**, mobile → always select. Replaces the earlier permanent topbar dropdown (which duplicated the left list). Realized in the `/__ui-mockup` shell mockup.
- 2026-06-21 — prdmgr/user revision (shell mockup ckpt, follow-up): collapsed desktop left nav is **fully hidden** (no thin rail, no status dots) with a single small **floating expand button** at the left edge; the main stage takes the freed width. Topbar collapsed-state mesh select unchanged.
