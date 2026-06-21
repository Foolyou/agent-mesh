# 11 · File / artifact viewer (+ images / lightbox / composer pending attachments) — coverage

**Scope / routes.** View an agent-published artifact: rendered markdown, highlighted
code, or an image — URL-addressable (right-click open-in-new-tab from any artifact
link/card). Also covers inline images, the image lightbox, and the composer's
pending-image tray. `/mesh/<m>/agent/<a>/artifact/<file>` (`artifact:`/`artifact://owner`
refs resolve here).
**Desktop/mobile.** Desktop: full rendered view + back; lightbox zoom. Mobile: same
full-screen reader + back; pinch-zoom (inherently identical — no divergence).
**Exists vs net-new.** [E] — viewer, AuthedImage, markdown/code render, lightbox,
composer pending images all ship; [N] restyle only.
**Sources read.** `../interaction/11-file-viewer.md`; repo: `FileViewer.tsx`,
`AuthedImage.tsx` (`isSameOriginApiUrl`, `useAuthorizedMedia` Bearer-fetch → object URL,
revoke on unmount), `Markdown.tsx` (artifact-rewrite), `Transcript.tsx` (inline images +
lightbox), composer pending-image tray.

## Function / control / action checklist
- **Open from artifact card/link** [E] — SPA nav to the viewer route.
- **Render content** [E] — markdown / code (highlighted) / image; gated /api fetch with Bearer (`AuthedImage`).
- **Back to conversation** [E].
- **Image zoom / lightbox** [E] — inline image → lightbox.
- **Composer pending-image tray** [E] — attach/preview/remove before send.

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable
(No **empty** — the route always targets a specific file → N/A; **permission** = artifact
not permitted folds into error per design.)

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Open from card/link [E] | N/A | ✓ | ✓ | ✓(bad ref→degrade to text) | △(context-less ref→inert) | N/A | ✓(cached) | ✓(deep path) | ✓ | ✓ |
| Render content [E] | N/A | ✓(Bearer fetch→spinner) | ✓(md/code/image) | ✓("not found"/"not permitted"/unsupported + back) | △(401→not permitted) | N/A | ✓(shows alt/last-known) | ✓(huge doc/code; long lines) | ✓ | ✓(full-screen) |
| Back to conversation [E] | N/A | ✓ | ✓ | ✓ | N/A | N/A | ✓ | N/A | ✓ | ✓ |
| Image zoom/lightbox [E] | N/A | ✓(loading image) | ✓ | ✓(broken→alt) | △(401→alt) | N/A | ✓(alt) | ✓(very large image; many images) | ✓ | ✓(pinch-zoom) |
| Composer pending-image tray [E] | ✓(none) | ✓(uploading) | ✓(thumbs) | ✓(upload failed+remove) | △(capability gated) | ✓(sending) | △(disabled offline) | ✓(N images; large file) | ✓ | ✓ |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/11-file-viewer.md`;
  `FileViewer.tsx`, `AuthedImage.tsx` (isSameOriginApiUrl/useAuthorizedMedia),
  `Markdown.tsx`, `Transcript.tsx` (inline image + lightbox), composer pending-image tray.
