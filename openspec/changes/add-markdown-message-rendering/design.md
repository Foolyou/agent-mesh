## Context

The web console's `Transcript.tsx` renders message text as an escaped plain
string inside `.bubble` (with `white-space: pre-wrap`). Agent output is markdown,
so all formatting shows as literal syntax. Messages arrive incrementally over a
WebSocket; each `message`/`thought` item carries the full accumulated `text` plus
a `complete` flag, and the UI updates in place as deltas land.

The styling system is 1330 lines of hand-written semantic CSS driven by a
15-variable palette (`themes.ts`), applied as CSS custom properties on `:root`.
Accessibility is enforced by a palette-level WCAG audit (`contrast.ts`,
`contrast.test.ts`, `a11y-audit.ts`) across 8 built-in themes — it reasons about
color role pairings, not DOM classes. The SPA is bundled by Bun via the
`import index from "./client/index.html"` HTML import.

## Goals / Non-Goals

**Goals:**
- Render agent messages and thought blocks as GFM markdown, including images.
- Tolerate partial markdown during streaming (no broken/unclosed-block artifacts).
- Keep user messages plain and tool output raw monospace.
- Harden links and images against prompt-injected agent output.
- Preserve the CSS-variable theme engine and the WCAG contrast guarantees.

**Non-Goals:**
- Syntax highlighting of fenced code (later change; render plain monospace now).
- Math/KaTeX rendering.
- Markdown for user-typed messages.
- A project-wide Tailwind migration (streamdown styling stays scoped).
- A user-facing "block remote images" toggle.

## Decisions

### Decision: Use `streamdown` as the markdown renderer

`streamdown` is purpose-built for streaming LLM output — it tolerates unclosed
blocks and memoizes parsed blocks so only the changing tail re-renders. It is
safe-by-default (no raw HTML) and supports GFM + images.

- **Alternatives considered:**
  - *`react-markdown` + `remark-gfm`, render only on `complete`*: simplest and
    lightest, but gives a "snap" at stream end and we'd hand-roll the
    block-memo + dangling-fence handling for live rendering. streamdown already
    solves this.
  - *`marked` + DOMPurify*: reintroduces a `dangerouslySetInnerHTML` XSS surface
    for semi-trusted agent output. Rejected.
  - *custom parser*: too many edge cases (nesting, fences, tables) for a PoC.

Because streamdown tolerates partial markdown, we render **live** (every delta),
not snap-on-complete.

### Decision: Scope markdown to agent prose surfaces only

Only `Msg` (role `agent`) and `Thought` render via the markdown component.
`Msg` (role `user`) keeps the existing escaped `pre-wrap` bubble; `ToolCard`
input/output keep raw monospace `.tout`. This matches the cross-industry pattern
(markdown on assistant turns, plain on user input) and avoids mangling
preformatted tool diffs.

### Decision: Style streamdown through the existing palette, not a Tailwind migration

streamdown ships Tailwind-oriented styles. We integrate it **scoped** — supply
our own element styling keyed to the 15-variable palette (the "Tier 0/1" path
explored separately) so the CSS-variable engine and contrast tooling stay
intact. The exact override mechanism (component/className overrides vs. scoped
Tailwind config) is settled during implementation; either way the project's CSS
system is not replaced. Headings render bold-not-huge, lists compact, inline
`code` on `bg-inset`, fenced blocks with a max-height scroll mirroring the
existing `.tout` pattern, tables with horizontal overflow.

### Decision: Link color reuses the `info` palette role

No new palette variable. Links use the existing `info` role; the contrast audit
gains a single `info`-on-surface pairing assertion, keeping the audit complete
without expanding the palette.

### Decision: Security hardening for links and images

Agent output is semi-trusted (prompt-injectable). No raw HTML passthrough.
- Links: `target="_blank" rel="noopener noreferrer"`, scheme allowlist
  (`http`/`https` only); other schemes (e.g. `javascript:`) are not rendered as
  active links.
- Images: auto-load (a product requirement) but hardened —
  `referrerpolicy="no-referrer"`, `loading="lazy"`, `src` scheme allowlist
  (`http`/`https`/`data`), and `max-width:100%` + a max-height/`object-fit`
  constraint so an image cannot blow up the bubble.

## Risks / Trade-offs

- **Image beacons / IP & referrer leakage from a prompt-injected agent** →
  Mitigated by `referrerpolicy="no-referrer"` + `loading="lazy"` (no fetch until
  viewed) + scheme allowlist. Residual risk (a viewed image still loads) is
  accepted for a local dev console; a "block remote images" toggle is deferred.
- **streamdown's default styling fighting our themes** → Override scoped to the
  markdown subtree using palette variables; do not adopt project-wide Tailwind.
  If override proves costly, fall back to `react-markdown` + a memoized wrapper.
- **Bundle weight added to the SPA** → Negligible impact for a local console;
  Bun bundles it automatically.
- **Markdown height changes disturbing autoscroll** → Covered by an e2e
  assertion that stick-to-bottom still pins after markdown renders.
- **New markdown elements failing WCAG in some theme** → Reuse audited palette
  roles; add the `info`-link pairing to `contrast.test.ts` and exercise elements
  in `a11y.e2e.ts`.

## Migration Plan

Additive presentation-layer change; no data, API, or process-model migration.
Rollback is reverting the `Transcript.tsx` render paths to the plain string and
removing the dependency. No impact on backend, ACP/MCP transports, or the
process-per-mesh model. Verification is DEV-only (temp instance on port 10020,
root `~/.agent-mesh-dev`).

## Open Questions

- Exact streamdown styling-override mechanism (component/className overrides vs.
  scoped Tailwind config) — resolved during implementation; constraint is "keep
  the CSS-variable system + contrast tooling intact."
- Confirm during implementation that `item.text` is the full accumulated string
  on each delta (assumed from the upstream transcript reducer).
