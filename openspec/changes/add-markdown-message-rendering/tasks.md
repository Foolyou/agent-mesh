## 1. Setup

- [x] 1.1 Add `streamdown` as a dependency (`bun add streamdown`) and confirm the SPA still bundles and boots on a temp DEV instance (port 10020, root `~/.agent-mesh-dev`).
- [x] 1.2 Confirm `item.text` is the full accumulated string on each delta (read the upstream transcript reducer); note the finding.
  - Finding: `reduceTranscript` appends incoming message/thought chunks to the open item and emits a `transcript.patch` whose `text` is the merged accumulated string.

## 2. Markdown renderer component

- [x] 2.1 Add a `Markdown` wrapper component in `src/web/client/` that renders text via `streamdown` with: raw HTML disabled, GFM enabled, link hardening (`target="_blank"`, `rel="noopener noreferrer"`, `http`/`https` scheme allowlist), and image hardening (`referrerpolicy="no-referrer"`, `loading="lazy"`, `http`/`https`/`data` scheme allowlist).
- [x] 2.2 Wire the wrapper into `Transcript.tsx`: render agent `Msg` (role `agent`) and `Thought` bodies through `Markdown`; leave user `Msg` and `ToolCard` input/output unchanged.

## 3. Theming

- [x] 3.1 Add themed CSS in `theme.css` for markdown elements (`h1–h6`, `ul/ol/li`, task lists, `code`, `pre`, `blockquote`, `a`, `table`, `hr`, `img`) using palette variables — headings bold-not-huge, compact lists, inline `code` on `bg-inset`, fenced blocks with max-height scroll (mirror `.tout`), tables with horizontal overflow, links = `info` role, images `max-width:100%` + max-height/`object-fit`.
- [x] 3.2 Verify rendering across all 8 built-in themes on the DEV instance (screenshot spot-check).

## 4. Accessibility

- [x] 4.1 Add the link (`info`) → surface contrast pairing assertion to `contrast.test.ts`; run `bun run src/web/a11y-audit.ts` and ensure all themes pass.
- [x] 4.2 Extend `a11y.e2e.ts` to exercise rendered markdown elements.

## 5. Tests (TDD)

- [x] 5.1 Extend `browser.e2e.ts`: agent `**x**`→`<strong>`, fence→`<pre><code>`, list→`<ul>`, link has `target="_blank"` + `rel="noopener noreferrer"`, `javascript:` link is inert, image has `referrerpolicy="no-referrer"` + `loading="lazy"`, disallowed image scheme makes no request.
- [x] 5.2 Add negative assertions: user message renders literal `**x**` (no `<strong>`), tool output stays raw monospace.
- [x] 5.3 Add a streaming assertion: an unclosed fence mid-stream does not break surrounding transcript content and resolves once closed.
- [x] 5.4 Add an autoscroll assertion: markdown height change keeps the transcript pinned to bottom.

## 6. Verify & commit

- [x] 6.1 Run `bun test`, `bun run src/web/browser.e2e.ts`, and `bun run src/web/a11y.e2e.ts` — all green.
- [x] 6.2 Commit on a feature branch with a Co-Authored-By trailer; keep commits small and working.
