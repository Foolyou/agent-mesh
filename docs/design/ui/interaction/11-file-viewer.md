# File / artifact viewer — interaction (Step 1)

Route: `/mesh/<m>/agent/<a>/artifact/<file>` (existing convention; `artifact:`/`artifact://owner` refs resolve here). Inputs: current `FileViewer`, artifacts system.

## Function
View an agent-published artifact/document: rendered markdown, code with highlighting, or an image — addressable by URL (right-click open-in-new-tab from any artifact link/card).

## Core user actions
- Open from an artifact card/link; read rendered content; back to the conversation; (image) zoom/lightbox.

## States
- **loading**: fetching bytes (AuthedImage / doc fetch with Bearer) → spinner.
- **populated**: rendered doc (markdown/code) or image.
- **error**: not found / not permitted / unsupported type → clear error ("artifact not found") + back.
(no empty — the route always targets a specific file.)

## Desktop
```
┌ ◀ back   <mesh>/<agent>/<file>                            ┐
│  rendered markdown / code / image                          │
│  (.file-viewer-path header + body)                         │
└────────────────────────────────────────────────────────────┘
```
- Full-stage view; deep-linkable; bytes fetched authorized (Bearer), images via blob (AuthedImage).

## Mobile
- Same full-screen rendered view + back; pinch-zoom for images.

## Mobile divergence
None meaningful (a document/image reader is inherently the same); just full-screen.

## Open questions
None.

## Change / review log
- 2026-06-20 — created (Step 1).
