## Why

The web console can only send plain text to agents, but users frequently need to
show an agent an image — a screenshot of a bug, a UI to reproduce, a diagram. ACP
already supports image content blocks (`{type:"image",mimeType,data}`) with
per-agent capability negotiation (`promptCapabilities.image`); the console just
doesn't use it. This adds first-class image upload to agent chat.

## What Changes

- The composer SHALL accept images via **paste**, **drag-and-drop**, and a
  **file-picker** button, on **all** chat surfaces (master agent, mesh routers,
  individual agents).
- Images are uploaded to a new backend endpoint and **stored once** under the
  root; the prompt carries lightweight refs, and image bytes are base64-encoded
  only at the ACP boundary. (Bytes do not ride the WS/NDJSON hot path.)
- Sent images SHALL appear as **inline thumbnails** in the user's own message
  bubble, with click-to-enlarge (lightbox).
- The attach affordance SHALL be **capability-gated**: hidden/disabled (with a
  tooltip) for any conversation whose agent does not advertise
  `promptCapabilities.image`.
- Constraints: PNG/JPEG/GIF/WebP only (SVG excluded), ≤10 MB each, ≤5 per message,
  validated on both client and server (server uses magic-byte sniffing).
- Upload lifecycle: stored per bucket (`<mesh>` or `master`) under
  `<root>/.agent-mesh/uploads/<bucket>/`; a mesh's bucket is deleted when the mesh
  is removed; the `master` bucket persists.

Non-goals (deferred):
- Client-side thumbnail pre-generation / hybrid inline+upload (Approach 3).
- Images in agent→user output beyond the already-shipped markdown image support.
- Time/size-budget garbage collection of uploads (lifecycle is mesh-scoped only).
- Audio/PDF/other non-image attachments.

## Capabilities

### New Capabilities
- `chat-image-upload`: attaching images to an agent prompt (input methods,
  validation, upload/storage, capability gating, delivery to the agent as ACP
  image content, transcript thumbnail display, and upload lifecycle).

### Modified Capabilities
<!-- None — no existing spec covers the chat composer / prompt payload yet. -->

## Impact

- **Code (UI)**: `src/web/client/ui.tsx` (Composer: input methods, attachment
  strip, validation, gating), `src/web/client/Transcript.tsx` (user-bubble
  thumbnails + lightbox), `src/web/client/store.ts` (prompt calls carry images;
  upload helper), `src/web/client/theme.css` (attachment + lightbox styles).
- **Code (backend)**: new upload + serve routes (`src/web/api.ts` /
  `src/web/api-server.ts`); prompt payload `{text, images?}` threaded through
  `src/web/gateway.ts`, `src/mesh-manager.ts`, mesh-host (NDJSON), and
  `src/web/transcript.ts`; ACP content construction + capability surfacing in
  `src/acp/client.ts` / `src/control-plane.ts` / `src/master-agent.ts`.
- **Storage**: new `<root>/.agent-mesh/uploads/<bucket>/` tree under the existing
  per-root data dir; cleanup hooked into mesh deletion.
- **Tests**: unit (validation/sniff, path safety, prompt threading, ACP
  content, gating) + new `src/web/images.e2e.ts`.
- **Dev/prod isolation & process model**: no change to the daemon/process model;
  uploads are read from the shared filesystem by the mesh-host at send time.
  Verify DEV-only (port 10020, root `~/.agent-mesh-dev`).
