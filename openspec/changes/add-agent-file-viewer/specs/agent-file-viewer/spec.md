## ADDED Requirements

### Requirement: HTTP route for per-agent file serving

The system SHALL expose `GET /api/agents/:name/files/*path` that resolves `:name` against the current mesh's running agents, looks up that agent's working directory through the existing control plane, and serves the file at `*path` interpreted relative to that working directory.

The route SHALL inherit the same exposure model as the existing `GET /api/uploads/:bucket/:id` route: no application-layer authentication, trust delegated to the transport layer (loopback / Tailscale). Adding an authentication layer is explicitly out of scope for this change.

The route SHALL set `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, and `Cache-Control: private, max-age=60` on every successful response.

#### Scenario: Successful Markdown fetch

- **WHEN** a client requests `/api/agents/codex/files/report.md` and the file exists at `<codex.cwd>/report.md`
- **THEN** the server responds `200` with `Content-Type: text/markdown; charset=utf-8` and the raw file bytes

#### Scenario: Successful image fetch

- **WHEN** a client requests `/api/agents/codex/files/diagram.png` and the file exists, the extension matches the image whitelist, and the first bytes match the PNG magic number
- **THEN** the server responds `200` with `Content-Type: image/png` and the raw file bytes

#### Scenario: Unknown agent

- **WHEN** a client requests `/api/agents/ghost/files/anything` and no agent named `ghost` is registered in the current mesh
- **THEN** the server responds `404` and SHALL NOT touch the filesystem

### Requirement: Path traversal and symlink protection

The system SHALL reject any request whose resolved absolute path escapes the agent's working directory or which traverses a symbolic link at any level.

Resolution SHALL use `path.resolve(cwd, decodeURIComponent(relPath))` and SHALL verify `resolved === cwd || resolved.startsWith(cwd + path.sep)` before any filesystem read.

Symlink detection SHALL use `lstat` (not `stat`) on the resolved path; if the final component is a symbolic link, the request SHALL be rejected with `400`.

#### Scenario: Parent-directory traversal blocked

- **WHEN** a client requests `/api/agents/codex/files/../../etc/passwd`
- **THEN** the server responds `400` and SHALL NOT read any file

#### Scenario: URL-encoded traversal blocked

- **WHEN** a client requests `/api/agents/codex/files/%2e%2e/%2e%2e/etc/passwd`
- **THEN** the server responds `400` and SHALL NOT read any file

#### Scenario: Symlink rejected

- **WHEN** a client requests `/api/agents/codex/files/link.md` and `link.md` is a symbolic link pointing inside or outside the working directory
- **THEN** the server responds `400` and SHALL NOT follow the link

### Requirement: Extension whitelist (D3)

The system SHALL serve only files whose extension is in the configured whitelist. Extensions outside the whitelist SHALL be treated as not existing.

The whitelist SHALL include at minimum:

- `.md`, `.markdown` served as `text/markdown; charset=utf-8`
- `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` served as the corresponding `image/*` type after magic-byte verification
- `.svg` served as `image/svg+xml`
- `.txt`, `.log`, `.json`, `.csv`, `.yaml`, `.yml`, `.toml` served as `text/plain; charset=utf-8`
- Code extensions `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`, `.html`, `.css`, `.sh`, `.sql` served as `text/plain; charset=utf-8`

The system SHALL NOT serve any file as `text/html` regardless of extension.

#### Scenario: Non-whitelisted extension returns 404

- **WHEN** a client requests `/api/agents/codex/files/secret.exe` and the file exists
- **THEN** the server responds `404` (indistinguishable from missing file)

#### Scenario: Image extension with wrong magic bytes returns 404

- **WHEN** a client requests `/api/agents/codex/files/fake.png` and the file exists but the first bytes are not a valid PNG header
- **THEN** the server responds `404`

#### Scenario: Code file served as text/plain

- **WHEN** an authenticated client requests `/api/agents/codex/files/server.ts` and the file exists
- **THEN** the server responds `200` with `Content-Type: text/plain; charset=utf-8`

### Requirement: File size limit

The system SHALL refuse to serve files larger than 5 MB.

#### Scenario: Oversize file rejected

- **WHEN** an authenticated client requests a whitelisted file larger than 5 MB
- **THEN** the server responds `413`

### Requirement: ACP content block preservation in transcript

The transcript reducer SHALL preserve `Image` and `ResourceLink` content blocks emitted by agents in `session/update` notifications by translating them into Markdown image and link syntax within the message text, rather than discarding them as plain-text extraction does today.

The preservation MUST be lossless to the renderer: the alt text or label, the URI or path, and any title MUST round-trip through the produced Markdown.

#### Scenario: Image block becomes Markdown image

- **WHEN** an agent emits a `session/update` with an `Image` content block referencing `path: "diagram.png"` with `alt: "topology"`
- **THEN** the resulting transcript message text contains `![topology](diagram.png)` in place of the structured block

#### Scenario: ResourceLink block becomes Markdown link

- **WHEN** an agent emits a `session/update` with a `ResourceLink` content block referencing `uri: "spec.md"` with `name: "Specification"`
- **THEN** the resulting transcript message text contains `[Specification](spec.md)` in place of the structured block

### Requirement: Relative-link rewriting in agent messages

When the Markdown renderer encounters an anchor with a non-HTTP relative `href` or an image with a non-HTTP relative `src` inside a context that names an authoring agent and mesh, it SHALL rewrite the URL using that author identity.

Anchors with a relative `href` SHALL be rewritten to the SPA viewer route `/mesh/:meshId/agent/:agentName/file/<path>`.

Images with a relative `src` SHALL be rewritten to the API route `/api/agents/:agentName/files/<path>` and rendered in place via `<img>`.

When no authoring agent context is present, the renderer SHALL fall back to the current behaviour of stripping the href / not rendering the image.

#### Scenario: Tappable Markdown link in agent message

- **WHEN** an agent named `codex` in mesh `dev` sends a message containing `[report.md](report.md)`
- **THEN** the rendered anchor has `href="/mesh/dev/agent/codex/file/report.md"` and tapping it navigates the SPA to the viewer

#### Scenario: Inline image with relative src

- **WHEN** an agent named `codex` in mesh `dev` sends a message containing `![](diagram.png)`
- **THEN** the rendered image has `src="/api/agents/codex/files/diagram.png"` and displays inline in the transcript bubble

#### Scenario: Mail body honours author identity

- **WHEN** a `MailEntry` with `from: "reviewer"` is rendered and the body contains `[checklist.md](checklist.md)`
- **THEN** the rewritten href points at `/mesh/:meshId/agent/reviewer/file/checklist.md`, using the mail sender as the authoring agent

#### Scenario: No author context preserves existing behaviour

- **WHEN** a Markdown component renders outside any author context and the text contains `[file.md](file.md)`
- **THEN** the rendered anchor has no `href` attribute (today's behaviour) and does not navigate

### Requirement: File viewer SPA route

The SPA SHALL expose a route `/mesh/:meshId/agent/:agentName/file/*path` that renders a `<FileViewer>` component selecting a renderer by file extension.

`.md` and `.markdown` SHALL render through the existing `<Markdown>` component (same sanitisation, same author context).

Image extensions SHALL render as `<img>` with a tap-to-zoom lightbox consistent with the existing `sent-images` lightbox.

Text and code extensions SHALL render as `<pre>` with Shiki syntax highlighting using the language inferred from the extension. Plain text extensions without a Shiki language SHALL render as `<pre>` without highlighting.

The viewer SHALL provide a visible back affordance that returns to the previous SPA history entry.

#### Scenario: Markdown viewer

- **WHEN** the user navigates to `/mesh/dev/agent/codex/file/report.md` and the fetch returns `200 text/markdown`
- **THEN** the viewer renders the Markdown using the same component used in transcript bubbles, with `AuthorContext` set to `{agent: "codex", meshId: "dev"}` so nested relative links also resolve

#### Scenario: Image viewer

- **WHEN** the user navigates to `/mesh/dev/agent/codex/file/diagram.png` and the fetch returns `200 image/png`
- **THEN** the viewer renders an `<img>` and the user can tap to enter the lightbox

#### Scenario: Code viewer with highlighting

- **WHEN** the user navigates to `/mesh/dev/agent/codex/file/server.ts` and the fetch returns `200 text/plain`
- **THEN** the viewer renders the file in a `<pre>` with TypeScript syntax highlighting

#### Scenario: 404 from viewer

- **WHEN** the API returns `404` for the requested path
- **THEN** the viewer renders an error message indicating the file was not found and shows a back affordance

### Requirement: Mobile-friendly viewer chrome

The file viewer SHALL render correctly at a viewport width of 375 px (iPhone SE), with no horizontal page scroll caused by chrome elements and with tap targets of at least 44×44 CSS pixels for the back affordance and lightbox controls.

#### Scenario: Mobile viewport renders without horizontal overflow

- **WHEN** the viewer is loaded at viewport `375×812`
- **THEN** the page `scrollWidth` does not exceed the viewport width and the back affordance is reachable without horizontal scrolling
