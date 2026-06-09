## 1. Backend file-serving module

- [x] 1.1 Create `src/web/agent-files.ts` exporting `resolveAgentFile(cwd, relPath)`, `extensionWhitelist`, and a `pickContentType(ext)` helper; share traversal/lstat logic style with `src/web/uploads.ts`
- [x] 1.2 Write `src/web/agent-files.test.ts` covering: ok paths, `../` traversal, percent-encoded traversal, NUL byte rejection, absolute path passed as relpath, symlink-final and symlink-mid, oversize (>5 MB) refusal, magic-byte verification for images, extension allowlist hit/miss matrix (D3 set)
- [x] 1.3 Make `bun test agent-files.test.ts` green before wiring the route

## 2. Gateway + HTTP route

- [ ] 2.1 Add `serveAgentFile(agentName, relPath)` on `src/web/gateway.ts` mirroring `serveUpload`; resolve agent → cwd through the existing control plane lookup; refuse unknown agents with `404`
- [ ] 2.2 Add `GET /api/agents/:name/files/*path` in `src/web/api.ts`; set `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, `Cache-Control: private, max-age=60` on success; map module errors (`enotfound`/`traversal`/`symlink`/`toobig`) to HTTP codes (404/400/400/413)
- [ ] 2.3 Add gateway-level test that asserts auth gating (401 for unauthenticated) and headers on a successful response

## 3. Transcript: preserve ACP Image / ResourceLink blocks

- [x] 3.1 Extend `src/web/transcript.ts` `textOf()` (or its callers) so `Image` content blocks emit `![alt](path-or-uri)` and `ResourceLink` blocks emit `[name](uri)`; round-trip alt/name/uri without loss
- [x] 3.2 Update `src/web/transcript.test.ts` (or add `src/web/transcript-content-blocks.test.ts`) with fixtures for Image-only, ResourceLink-only, and mixed text+blocks updates

## 4. Frontend AuthorContext + Markdown rewriting

- [ ] 4.1 Create `src/web/client/AuthorContext.tsx` exporting `AuthorContext` (`{agent, meshId}`) and `useAuthor()` hook
- [ ] 4.2 Add `isRelativeRef()` helper + `Anchor` / `Image` rewriting in `src/web/client/Markdown.tsx`: when `useAuthor()` returns a value and the URL is a non-HTTP relative reference, rewrite to viewer route (anchor) or API URL (image); preserve current strip behaviour when context is absent
- [ ] 4.3 Wrap `Msg`, `MailBubble`, and any other transcript bubble using `<Markdown>` in `src/web/client/Transcript.tsx` with `<AuthorContext.Provider value={…}>`; mail uses `MailEntry.from` as agent
- [ ] 4.4 Add `src/web/client/markdown-rewrite.test.ts` covering: http href untouched, relative href + context → viewer route, relative href no context → no href, relative img src + context → API URL, encoded paths preserved

## 5. File viewer SPA route

- [ ] 5.1 Create `src/web/client/FileViewer.tsx` that reads route params, fetches `/api/agents/:agentName/files/:path`, and picks renderer by extension: Markdown → `<Markdown>` (wrapped in `<AuthorContext.Provider>` so nested links resolve), image → `<img>` + lightbox reused from `sent-images`, code/text → `<pre>` with Shiki highlighting
- [ ] 5.2 Add the `/mesh/:meshId/agent/:agentName/file/*path` route to the SPA router entrypoint (`src/web/client/app.tsx` or equivalent); ensure browser back returns to the prior history entry
- [ ] 5.3 Add styles to `src/web/client/theme.css`: viewer container, back-affordance ≥44×44 px, mobile-friendly padding, Shiki theme tokens aligned with existing dark/light palettes

## 6. End-to-end coverage (Playwright)

- [ ] 6.1 Create `src/web/file-viewer.e2e.ts` using existing `fake.ts` patterns; fixture a mesh with an agent whose CWD contains `report.md`, `diagram.png`, `server.ts`, plus a symlinked decoy and a non-whitelisted `secret.exe`
- [ ] 6.2 Desktop pass: tap `[report.md](report.md)` in an injected agent message → viewer renders Markdown; inline `![](diagram.png)` shows in-bubble; tap `[server.ts](server.ts)` → highlighted code; tap a missing path → 404 viewer with working back
- [ ] 6.3 Mobile pass (`viewport: 375×812`): same assertions plus `page.scrollWidth <= 375` and back-affordance tap target measured via bounding box
- [ ] 6.4 Negative pass: request `../../etc/passwd` via direct API call → expect `400`; request `secret.exe` → expect `404`; request symlinked file → expect `400`

## 7. Manual verification on dev instance

- [ ] 7.1 Start a temp dev instance: `bun run src/main.ts --port 10020 --root ~/.agent-mesh-dev`; create a mesh; have an agent write `note.md` + a small `.png` into its worktree; tap both links from a real phone over Tailscale
- [ ] 7.2 Kill the dev instance after verification; do NOT touch the prod instance on port 10010

## 8. Wrap-up

- [ ] 8.1 Run full `bun test` and `bun run e2e` (or the project's e2e entrypoint); fix any regressions
- [ ] 8.2 `openspec status --change add-agent-file-viewer` reports all tasks done; archive via `/opsx:archive` once merged
