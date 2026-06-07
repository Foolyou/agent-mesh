## 1. Backend: upload storage + serving

- [x] 1.1 Add `POST /api/uploads?bucket=<mesh|master>` in `src/web/api.ts`/`api-server.ts`: validate (server-side magic-byte sniff for PNG/JPEG/GIF/WebP, ≤10 MB, ≤5/req), store at `<root>/.agent-mesh/uploads/<bucket>/<uuid>.<ext>`, return `{id,url,mimeType,name}`. Validate bucket against known meshes/`master` (no traversal).
- [x] 1.2 Add `GET /api/uploads/<bucket>/<id>` serving the file with correct `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`.
- [x] 1.3 Hook upload-bucket deletion into the mesh-removal path; `master` bucket persists.

## 2. Prompt payload: thread images end-to-end

- [x] 2.1 Extend the prompt payload to `{text, images?: {id,mimeType,name}[]}` through `store.ts` → `/api/.../prompt` → `gateway.ts` (promptRouter/promptAgent/promptMaster) → `mesh-manager.ts` → mesh-host (NDJSON) → `control-plane.prompt` / `master-agent.prompt`. Text-only prompts must remain unchanged.
- [x] 2.2 In `src/acp/client.ts`, extend `prompt(text, images?)` to read each stored file and append ACP `{type:"image",mimeType,data:<base64>}` blocks after the text block. Missing file → skip with logged warning, still send text + readable images.

## 3. Capability surfacing + gating

- [x] 3.1 At session init, surface `promptCapabilities.image` per agent (and for master) into gateway state (new event/field), analogous to mode surfacing.
- [x] 3.2 Expose the capability in the client store so the composer can gate per-conversation.

## 4. Composer UI

- [x] 4.1 In `src/web/client/ui.tsx` Composer: add paste, drag-drop, and file-picker (📎) input methods; client-side validation (type/size/count, reject SVG) with inline error messages.
- [x] 4.2 Pending-attachment thumbnail strip with per-item remove (×); on send, upload via the store helper then call prompt with image refs; clear on send.
- [x] 4.3 Capability gating: hide/disable the attach affordance with a tooltip when the active conversation's agent lacks image support.

## 5. Transcript display

- [x] 5.1 Add optional `images:[{url,name}]` to the `message` transcript item (`src/web/types.ts` + `src/web/transcript.ts` reducer); attach URLs at the user-message echo point (locate that spot first).
- [x] 5.2 Render inline thumbnails in the user bubble (`Transcript.tsx`) with a click-to-enlarge lightbox modal; theme attachment strip + thumbnails + lightbox in `theme.css` using palette vars.

## 6. Tests (TDD)

- [x] 6.1 Unit: server upload validation (magic-byte sniff, size, count), bucket path safety, prompt payload threading, ACP text+image content construction, capability-gating logic.
- [x] 6.2 New `src/web/images.e2e.ts`: attach via paste/drop/pick, thumbnail strip + remove, send → user bubble thumbnail + lightbox opens, capability-gated hide for non-image agent, reject SVG/oversize/6th image.

## 7. Verify & commit

- [x] 7.1 Run `bun test` + relevant e2e (`browser.e2e.ts`, new `images.e2e.ts`, `a11y.e2e.ts`) — all green; DEV-only manual check on port 10020 / `~/.agent-mesh-dev`, killed after.
- [x] 7.2 Small working commits on a feature branch, each with a Co-Authored-By trailer.
