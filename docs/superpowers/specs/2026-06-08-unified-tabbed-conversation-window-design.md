# Unified Tabbed Conversation Window (Stage C)

Date: 2026-06-08
Status: design — pending implementation

## Goal

Merge the per-mesh **router chat** panel and the **member agent** panel into a single
panel driven by one tab bar. The router tab is pinned first and always visible; member
tabs live in a horizontally-scrollable strip that hides its scrollbar and surfaces an
overflow dropdown. This also delivers the "router status light" (originally Stage B):
every tab — including the pinned router — carries a status `Dot`.

## Why

Today `MeshDetail` renders two separate panels (`routerChat` ~L343, `AgentPanels` ~L149)
for what is conceptually one thing: "the conversations in this mesh." Splitting them
wastes vertical space, gives the router no status indicator, and does not scale when a
mesh has many members. One tab bar with a pinned router scales and unifies the controls.

## Scope

In scope:
- A single conversation panel with a unified tab bar (router pinned + scrollable members + overflow dropdown).
- Status `Dot` on every tab, including the router (subsumes standalone Stage B).
- Per-conversation control row (effort / mode / interrupt; fullscreen toggle) following the active tab.
- Desktop + mobile.

Out of scope (revisit only if needed): drag-to-reorder tabs, closeable tabs, per-tab
unread badges, folding the cross-mesh **Mesh Assistant (master)** into this window
(master stays in its own location — it is not part of any single mesh's roster).

## Design

### Component structure

Replace `routerChat` (MeshDetail.tsx ~L343-374) and the `AgentPanels` component
(~L149-198) with one `ConversationPanel` component that owns:

- the unified tab bar,
- a single "active conversation" selection (router **or** a member),
- the active conversation's control row + `ChatPane`.

The active-conversation state generalizes today's `selectedAgent`: it can be the router
id or a member id. **Default active = router.** Selecting a topology node still activates
the corresponding tab (router node → router tab).

### Tab bar layout

```
[📌 ●lead router] | [●impl] [●review] [●builder] …scroll… |   [⋯N ▾]
   pinned, fixed        horizontally scrollable strip          pinned
```

- **Router tab** — pinned leftmost, never scrolls, `📌` + `Dot` + label. Visually
  distinct (e.g. inset background + right divider) so it reads as "anchor".
- **Member strip** — `flex:1; overflow-x:auto; min-width:0`. Each tab: `Dot` + id.
  - Scrollbar hidden: `scrollbar-width:none` + `::-webkit-scrollbar{ display:none }`.
    Wheel / trackpad / drag scrolling still works.
  - **Right edge fade** (chosen option B): a `mask-image: linear-gradient(to right,#000 ~82%,transparent)`
    on the strip as a subtle "more to the right" hint.
  - On activate, the selected member tab `scrollIntoView({ inline: "nearest" })`.
- **Overflow dropdown** — pinned far right, `⋯N ▾` where N = member count. Opens a menu
  listing **all** members (including those scrolled out of view) with their `Dot`; click
  jumps to (activates + scrolls to) that tab. Closes on select / outside-click / Esc.

### Tab status dot

Reuse existing `Dot` + the existing rule from AgentPanels.tsx L167:
`status = (mesh running/starting) ? agent.status : "stopped"`. Apply identically to the
router tab (this is the Stage B deliverable). No new status plumbing — the router's
`status`/`activity` already flow through `MeshSummary.agents`.

### Control row (follows active tab)

One control row under the tab bar, bound to the active conversation:
- `harness` label (members show it today; show for router too).
- `EffortControl` for the active agent.
- `interrupt` button + `ModeControl` while the mesh is live.
- **Fullscreen toggle** (`⊞/⊟`) — currently router-only; keep it available for the active
  conversation (router and members alike) since the window is now shared.

`ChatPane` below renders the active conversation's transcript + composer, wired to
`promptRouter` when the router tab is active and `promptAgent` otherwise; `imageEnabled`
from `pm.capabilities[activeId]`.

### Desktop layout

The unified `ConversationPanel` takes the slot the router chat panel occupies today (the
dominant left/main region). The separate member panel is removed. Right rail (topology,
activity, mailbox, history) and permission cards are unchanged.

### Mobile

Today mobile has separate `chat` (router) and `agents` segments (~L449-450). Collapse
them into a single `chat` segment hosting `ConversationPanel`; drop the `agents` segment
from the `mtabs` switcher (map / log unchanged). The tab bar's pinned-router +
scroll-strip + `⋯N` works as-is on narrow widths.

## Testing

Extend `src/web/browser.e2e.ts` (drives the `--fake` mesh which has router + 2 members):
- router tab is pinned-left, present, and shows a status `Dot` (Stage B regression).
- clicking a member tab switches the `ChatPane` to that member's transcript; clicking the
  router tab switches back.
- with many members injected (reuse the overflow-injection pattern), the member strip does
  not show a scrollbar (assert computed `overflow-x` scrolls but scrollbar width is 0 / the
  strip is horizontally scrollable) and the `⋯N` dropdown lists all members and jumps on click.
- control row reflects the active tab (effort/mode/interrupt target the active agent).
- mobile viewport: single `chat` segment hosts the tab window; no separate `agents` segment.

Keep `bun test` green; add/adjust any AgentPanels-specific unit assertions that move.

## Risks / notes

- This is a layout refactor of `MeshDetail.tsx`; keep `ChatPane`, `EffortControl`,
  `ModeControl`, `Topology`, and the reducer untouched — only the panel composition and a
  new tab bar change.
- Topology→tab activation must include the router node (today `selectedAgent` is members-only).
- i18n: add keys for the overflow dropdown; reuse existing chat/agent strings otherwise.
