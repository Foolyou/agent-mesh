## Context

Today a prompt is a plain `{text}` string sent over REST (`store.ts` →
`/api/.../prompt`), threaded through gateway → manager → mesh-host (NDJSON) →
`control-plane.prompt` → `AcpAgentConnection.prompt`, which builds ACP content
`[{type:"text",text}]` (`src/acp/client.ts:217`). The transcript is broadcast to
every connected client over a single WebSocket, and the daemon model rebuilds
transcripts on reconnect. ACP supports image content blocks and advertises
`promptCapabilities.image` per agent at session init.

## Goals / Non-Goals

**Goals:**
- Attach images (paste/drop/pick) on all chat surfaces and deliver them to
  image-capable agents as ACP image content.
- Keep the WS/NDJSON hot path light (refs/URLs, not bytes).
- Show sent images in the user's transcript bubble.
- Validate and store safely; gate by agent capability.

**Non-Goals:**
- Hybrid inline-thumbnail upload (Approach 3); client thumbnail pre-gen.
- Non-image attachments; time/size-budget GC of uploads.

## Decisions

### Decision: Upload-endpoint + stored files + refs (Approach 2)

Browser POSTs images to `/api/uploads`; backend stores under
`<root>/.agent-mesh/uploads/<bucket>/<uuid>.<ext>` and returns
`{id,url,mimeType,name}`. The prompt carries refs; bytes are base64-encoded only
at the ACP boundary (mesh-host/master read the file at send time — same machine,
shared FS).

- **Alternative — inline base64 end-to-end (Approach 1):** simplest, but up to
  ~50 MB/message of base64 echoed over the WS to all clients and re-sent on every
  transcript rebuild. Rejected on cost.
- **Alternative — hybrid (Approach 3):** snappier, but premature; deferred.

### Decision: Transcript carries URLs, not bytes

The `message` transcript item gains optional `images:[{url,name}]`. Thumbnails
and the lightbox `GET /api/uploads/<bucket>/<id>`. This keeps the broadcast small
and survives reconnect (served from storage).

### Decision: Capability gating from advertised promptCapabilities.image

Session init already surfaces modes; also surface `promptCapabilities.image` into
gateway state so the client can hide/disable attach per-conversation (master
included). Prevents composing turns an agent will reject.

### Decision: Defense-in-depth validation + safe serving

Validate client-side (type/size/count, reject SVG) and re-validate server-side by
magic-byte sniffing (not extension/declared type). Server-generated UUID ids;
bucket validated against known meshes/`master` (no traversal). Serve with correct
`Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`.
No SVG ⇒ no inline-script vector. These are *user-chosen local* images, so the
remote-image hardening from the markdown change does not apply here.

### Decision: Mesh-scoped lifecycle

Uploads bucketed by mesh (or `master`); a mesh's bucket is deleted on mesh
removal (hook into the existing delete path). Simple cleanup tied to an existing
lifecycle; no separate GC.

## Risks / Trade-offs

- **New storage/serving surface** → Bounded: one upload route, one serve route,
  one cleanup hook; reuses the per-root data dir convention.
- **Large base64 at ACP boundary per turn** → Bounded by ≤10 MB × ≤5 caps;
  encoded lazily only when actually sending to an image-capable agent.
- **User-message echo path for images** → The exact spot where the user's sent
  message enters the transcript must be located so image URLs attach there;
  confirmed during implementation (not a design decision).
- **Harness divergence** → Some harnesses may not set `promptCapabilities.image`;
  gating handles this honestly (attach simply not offered).

## Migration Plan

Additive. New routes, an extended prompt payload (text-only prompts unchanged),
and a new storage subtree. No process-model or data migration. Rollback = revert
the UI/route/payload changes and drop the uploads dir. DEV-only verification
(port 10020, root `~/.agent-mesh-dev`).

## Open Questions

- Multipart vs. raw-body upload encoding for `/api/uploads` — implementer's call;
  constraint is server-side size/type enforcement.
- Exact user-message→transcript echo location (see Risks).
