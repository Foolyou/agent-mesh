## Context

Agents in this mesh produce filesystem artefacts as a normal part of their work — Markdown analyses, generated images, code, log dumps — and reference them in their chat messages with relative paths (`[report.md](report.md)`). Today the web console renders those links through `src/web/client/Markdown.tsx:Anchor`, which only accepts `http(s)` URLs and silently drops everything else. The result on mobile: a styled-but-dead link, and no other path to reach the file from the UI.

Adjacent infrastructure already exists in three places that this change must integrate with:

- **Uploads pipeline** (`src/web/uploads.ts`, `src/web/gateway.ts:serveUpload`) — a complete model for path validation, magic-byte sniff, and serving bytes via `/api/uploads/{bucket}/{id}`. Image only, scoped to controller-owned uploads, **not** suitable as-is for serving from arbitrary agent CWDs.
- **Transcript reducer** (`src/web/transcript.ts:textOf`) — flattens every ACP `ContentBlock` to text via recursive best-effort extraction, throwing away structured `Image` / `ResourceLink` / `EmbeddedResource` blocks.
- **Markdown rendering** (`src/web/client/Markdown.tsx`) — `streamdown` with a `rehype-sanitize` chain; the renderer doesn't know which agent authored the message it's currently rendering.

The control plane already tracks each running agent's `cwd` (it spawns them and knows the worktree), so the *resolution* problem is trivial; the work is the *plumbing* and the *trust boundary*.

## Goals / Non-Goals

**Goals**

- A user on a phone, looking at a transcript, can tap a relative link in an agent message and immediately see the rendered file.
- Agent-produced inline content (Image / ResourceLink ACP blocks) reaches the same surface, even if the agent didn't write Markdown markup itself.
- The trust boundary is explicit and narrow: agent file content reaches the browser only via a single guarded route, only from inside the authoring agent's CWD, only for whitelisted file types, only via session-authenticated requests.
- Reuses existing primitives (streamdown for `.md`, Shiki for code, `<img>` for images, the `serveUpload` pattern for streaming bytes) — no new runtime dependencies.

**Non-Goals**

- A discoverability surface (Files tab / artefacts panel) is deferred to a follow-up change; this change makes links work but does not enumerate.
- Mail attachment schema, presenter tool, multi-agent file references, write/edit/delete, large-file streaming, archive/PDF/video preview, full-text search.

## Decisions

### Decision 1: One HTTP route, scoped per-agent

`GET /api/agents/:name/files/*path` resolves `:name` against the current mesh's agent list (via the existing gateway), looks up its `cwd`, and serves from there.

**Alternatives considered:**

- *One route over all agent files (`/api/files/...`) with the agent embedded as a path segment*: encourages agents-as-strings everywhere, and we'd still want mesh scoping.
- *Per-mesh route (`/api/mesh/:id/files/...`) with agent in the body*: extra round-trip for resolution and doesn't match the natural `<agent>/<relpath>` mental model.
- *Tunnelling through the existing WebSocket as binary deltas*: turns a request/response into a stateful protocol, breaks browser caching, blocks `<img src>` use.

**Why this choice:** matches how the data is actually shaped (agent owns a cwd, file is relative to it). The URL is human-debuggable. Browser `<img src>` works without changes. Cacheable.

### Decision 2: Relative-link rewriting lives in the Markdown component, fed by a React context

`Markdown.tsx` learns about authorship through a new `AuthorContext` (`{agent, meshId}`) wrapped around every transcript bubble. `Anchor` and `Image` read the context and rewrite relative URLs.

**Alternatives considered:**

- *Rewrite at ingest in `transcript.ts`*: would mutate agent-authored text on the server side; loses fidelity (the original link is interesting), and makes the same text render differently in different views.
- *Rewrite in a custom `rehype` plugin*: works, but harder to thread per-message state (the author identity) than a React context. Plugins run once at parse, components render with live context.
- *Pass author down as a prop to `<Markdown>` and have it inject*: works but every consumer must remember to thread the prop. Context lets `Markdown` opt in safely (`Anchor` falls back to current strip-href behaviour when no context, preserving existing tests).

**Why this choice:** localises a UI concern to UI code; preserves transcript fidelity; backward compatible (consumers without a provider get today's behaviour).

### Decision 3: Restore ACP `Image` / `ResourceLink` blocks by emitting Markdown into the message text

In `transcript.ts:textOf`, `Image` blocks become `![alt](data:...|path)` and `ResourceLink` blocks become `[name](uri)`, appended to (or interleaved with) the text content of the same message. No new TranscriptItem kind.

**Alternatives considered:**

- *New `attachment` TranscriptItem kind*: doubles UI surface, requires a separate renderer, splits the conversation visually for blocks that the agent intended as inline.
- *Pass raw ContentBlocks through and render in `Msg`*: leaks ACP shapes into UI components, doubles rendering paths for what is functionally markdown.

**Why this choice:** one rendering pipeline; the markdown component (with relative-link rewriting from Decision 2) handles both "user wrote relative links" and "agent emitted blocks". Agents that use blocks and agents that write markdown both flow through the same UI codepath.

### Decision 4: D3 extension whitelist with magic-byte verification on images

Server-side allowlist: `.md .markdown`, image extensions (with `sniffImage()` magic-byte check), text/log/config extensions, common code extensions. Non-whitelisted → 404 (do not disclose existence). Mismatched image magic bytes → 404. Symlinks (any direction) → 400.

**Alternatives considered:**

- *Allow any text/* MIME via `file` sniff*: error-prone on cross-platform binaries; harder to reason about; expanding by a dozen extensions later is trivial.
- *Whitelist only D1 (md+images)*: misses common agent outputs (`.log`, `.json`, `.ts`); the user's primary use case is reviewing agent products on mobile.
- *Render `text/html` for HTML files*: too dangerous (cookie scope, script execution); intentionally not in the whitelist for v1.

**Why this choice:** D3 covers the realistic surface for coding agents (markdown notes, generated images, code review on the go) while keeping the trust boundary tight. Sniffing only for images is enough because non-image text files are served as `text/plain` regardless of contents.

### Decision 5: SPA navigation, not target=_blank, for non-image renders

`.md` and code/text links open the in-app `<FileViewer>` route. Inline `<img>` continues to render in place. We never `target="_blank"` to the API route for renderable text — the browser would show raw bytes.

**Alternatives considered:**

- *Open the API route directly in a new tab*: ergonomic for images (browsers handle them) but breaks for `.md` and code, and produces inconsistent UX across types.
- *Modal viewer over the transcript*: nicer for "quick peek", but loses deep-linkability and the mobile back gesture; UX inconsistent between modal-from-link and direct-URL access.

**Why this choice:** mobile back gesture works without special handling, links are shareable, deep-linkable, and bookmarkable, and the viewer can grow features (header bar, raw-download fallback, copy-path) without contending with overlay z-stack issues.

### Decision 6: No caching of file metadata in the gateway

Each `serveAgentFile` call lstats the path fresh and streams. Short `Cache-Control: private, max-age=60` lets the *browser* cache; the server keeps no state.

**Alternatives considered:**

- *Watch agent CWDs and maintain a file index*: would unlock A2 (Files panel) cheaply, but the panel is out of scope and the watch overhead per agent is non-trivial. Defer.
- *In-memory ETag map*: another state surface to invalidate; not needed at this scale.

**Why this choice:** stateless serving is simplest, matches `serveUpload`, and is correct under agent edits without explicit invalidation.

## Risks / Trade-offs

- **Symlinks inside the worktree are sometimes legitimate** (a project might symlink `vendor/`, monorepo layouts), but resolving them safely against the cwd boundary is subtle. → For v1 we reject every symlink. If we hit a real workflow that needs them we can re-evaluate with `realpath` + cwd-prefix check.
- **Agent renames or deletes a referenced file between message send and tap.** → 404 with a clear viewer error and a back button. Acceptable — transcript is history, not an archive guarantee.
- **CWD survives but contains a multi-GB log.** → For v1 we accept that streaming will be slow; we cap requests at 5 MB (413 with a clear viewer error) to bound per-request memory. Larger files are an explicit non-goal.
- **`Markdown.tsx` consumers that don't wrap `<AuthorContext.Provider>` lose nothing**: `Anchor` falls back to today's `href = undefined` behaviour. Worst case is the same as today. The risk is *forgetting* to wrap, producing dead links instead of working ones — addressed by wrapping at the Transcript level (single chokepoint) and by an e2e test that asserts agent links resolve.
- **Two URL spaces for the same bytes** — `/api/agents/.../files/foo.png` (image render) and `/mesh/.../agent/.../file/foo.png` (viewer for the same file). → Acceptable: one is the data plane (cacheable, content-negotiated), the other is a viewer page; same separation we already have between `/api/uploads` and any UI lightbox.
- **Path traversal regressions** — the single biggest danger. → Mitigated by sharing helpers with `src/web/uploads.ts`, by a dedicated test file covering escape attempts (`../`, percent-encoded, NUL, absolute path passed as relpath, lstat-symlink), and by treating any deviation from `path.resolve(cwd, rel).startsWith(cwd + sep)` as a test failure.
- **ACP block restoration changes transcript text** in ways consumers downstream (e.g., search) might not expect. → No current consumer depends on the post-flatten text shape; covered by `transcript.test.ts` adjustments.
