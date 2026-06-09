## Why

Agents already write Markdown reports, diagrams, code, and logs into their worktrees and reference them by relative path in chat messages (e.g. `[analysis.md](analysis.md)`). On the current web UI those links are dead: `Markdown.tsx` strips any href that is not `http(s)`, so on mobile a user sees an underlined link that does nothing when tapped. There is no way to see agent-produced files from the web console at all — users must SSH into the worktree. Closing this gap unlocks the primary on-the-go review flow ("agent finishes, I check the result from my phone").

## What Changes

- Add an HTTP route `GET /api/agents/:name/files/*path` that serves files from the named agent's CWD (mesh-scoped), with path-traversal protection, symlink rejection, extension whitelist (D3: markdown / images / common text / code), and strict `Content-Type` headers.
- Add a SPA route `/mesh/:meshId/agent/:agentName/file/*path` rendered by a new `FileViewer` component that picks renderer by extension: `streamdown` for `.md`, `<img>` lightbox for images, Shiki-highlighted `<pre>` for code/text.
- Teach `Markdown.tsx` (`Anchor`, `Image`) to rewrite relative URLs using an `AuthorContext` provided per transcript bubble. Relative links to renderable types navigate to the SPA viewer; inline images render in place against the API URL.
- Preserve ACP `Image` and `ResourceLink` content blocks emitted by agents in `src/web/transcript.ts` `textOf()` — currently flattened to text and discarded. Render them through the same Markdown pipeline (no new transcript item kind).
- Add Playwright coverage (`src/web/file-viewer.e2e.ts`) including a phone-sized viewport pass.

### Non-goals

- A "Files" panel listing every artefact an agent has produced (deferred to a later change).
- Extending `send_mail` schema with attachments.
- A dedicated `present_to_user` tool.
- Any write/edit/delete of agent files from the web UI.
- PDF / video / archive preview, full-text search, cross-agent file references, large-file chunking.

## Capabilities

### New Capabilities

- `agent-file-viewer`: per-agent HTTP file serving and a web viewer that renders Markdown, images, and highlighted code from each agent's worktree, with relative links inside agent messages auto-resolved to the originating agent.

### Modified Capabilities

(none — first capability defined in this repo.)

## Impact

- **Backend**: new module `src/web/agent-files.ts` (path resolution, whitelist, sniff); new route in `src/web/api.ts`; new gateway method in `src/web/gateway.ts` analogous to `serveUpload()`; `src/web/transcript.ts` `textOf()` updated to preserve `Image` / `ResourceLink` content blocks as Markdown.
- **Frontend**: new `src/web/client/FileViewer.tsx`, `src/web/client/AuthorContext.tsx`; edits to `src/web/client/Markdown.tsx`, `src/web/client/Transcript.tsx`, the SPA router entrypoint, and `src/web/client/theme.css`.
- **Process model**: no change. The new route reads from each running agent's `cwd` that the control plane already tracks. No new process, no new daemon surface, no change to backend↔host NDJSON, no change to MCP/ACP protocols.
- **Dev/prod isolation**: no change. The route is mounted on the existing Bun web server and inherits its session auth. No new auth surface.
- **Dependencies**: no new runtime dependencies — `streamdown` already pulls in Shiki, used here for the code viewer.
- **Security surface**: read-only filesystem exposure of agent CWDs, gated by mesh-scoped session auth, traversal guard, lstat-based symlink rejection, extension whitelist, magic-byte sniff for images, `Content-Security-Policy: default-src 'none'` + `X-Content-Type-Options: nosniff` on all responses.
