## Why

Agent output is markdown — LLMs emit `**bold**`, headings, lists, fenced code,
tables, links, and images constantly — but the web console renders message text
as an escaped plain string, so all of that shows as literal syntax. This makes
agent replies and reasoning hard to read in exactly the surfaces users watch
most. Established AI chat UIs render markdown on assistant turns; we should too.

## What Changes

- Render **agent messages** and **thought blocks** as markdown instead of plain
  escaped text, using a streaming-tolerant renderer (`streamdown`) so partial
  markdown during token streaming renders cleanly (no broken/unclosed blocks).
- Support GFM: headings, ordered/unordered/task lists, bold/italic/strikethrough,
  inline + fenced code, blockquotes, tables, horizontal rules, links, and images.
- **User messages stay plain** (escaped, `pre-wrap`) and **tool input/output stay
  raw monospace** — markdown applies only to agent-authored prose surfaces.
- Security hardening for semi-trusted (prompt-injectable) agent output:
  - no raw HTML passthrough;
  - links open in a new tab with `rel="noopener noreferrer"` and a scheme
    allowlist (drop `javascript:`/other non-http(s) schemes);
  - images auto-load but hardened — `referrerpolicy="no-referrer"`,
    `loading="lazy"`, `src` scheme allowlist (`https`/`http`/`data`), and a
    max-size constraint so an image can't blow up the chat bubble.
- Theme the new markdown elements to fit the dense terminal aesthetic, reusing
  the existing 15-variable palette (links use the `info` role); keep the
  CSS-variable theme engine and the WCAG contrast tooling intact.

Non-goals (deferred to later changes):
- Syntax highlighting of fenced code (render as plain themed monospace for now).
- Math/KaTeX rendering.
- Markdown for user-typed messages.
- A user-facing "block remote images" privacy toggle.
- Replacing the project's CSS system with Tailwind (streamdown styling is scoped
  so the existing CSS-variable system and contrast tooling are untouched).

## Capabilities

### New Capabilities
- `message-markdown-rendering`: how agent-authored message and thought text is
  rendered as markdown in the web console — scope (which surfaces render markdown
  vs stay plain/raw), supported markdown features, streaming behavior, security
  constraints on links and images, and theming/accessibility requirements.

### Modified Capabilities
<!-- None — no existing spec captures transcript rendering yet; this is the first. -->

## Impact

- **Code**: `src/web/client/Transcript.tsx` (agent `Msg` + `Thought` render paths),
  `src/web/client/theme.css` (themed markdown element styles), and a new markdown
  renderer wrapper component. User-message and tool-card render paths unchanged.
- **Dependencies**: adds `streamdown` (and its transitive markdown stack) to the
  Bun-bundled SPA. Styling integrated via the existing CSS-variable palette
  (scoped; no project-wide Tailwind adoption).
- **Tests**: extend `src/web/browser.e2e.ts` (markdown render assertions + the
  user-plain / tool-raw negative assertions), `src/web/a11y.e2e.ts` (new
  elements), and `src/web/client/contrast.test.ts` (link = `info` pairing).
- **Accessibility**: new element/role pairings must continue to pass the WCAG
  audit across all 8 themes.
- **Dev/prod isolation & process model**: no impact — change is confined to the
  SPA presentation layer; backend, ACP/MCP transports, and the process-per-mesh
  model are untouched. Verification follows the DEV-only rule (temp instance on
  port 10020, root `~/.agent-mesh-dev`).
