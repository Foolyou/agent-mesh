# Step 2 components — 04 Conversation

Shared by **runtime focused transcript** and **Mesh Assistant** (and AuthedImage by file-viewer). One conversation system, two mounts.

## TranscriptItem family
- **Purpose**: render the folded ACP stream as coherent items. Sub-types (each a part):
  - **MessageBubble** (user / agent; streaming/complete; optional sent-images).
  - **Thought** (collapsible reasoning).
  - **ToolCallCard** (title + status chip pending/in_progress/completed/failed + input/output disclosure).
  - **PlanCard** (checklist entries).
  - **MailItem** (inter-agent mail in transcript).
  - **CompactItem** (context-compaction marker).
  - **Divider** (session/new-session boundary; the new-session marker).
  - **AttachmentCard** (see below).
- **States**: streaming vs complete; error; long-content truncation/backfill (transcript loaded via backfill endpoint, not /api/state — Step1 routing note).
- **Surfaces**: runtime, assistant. **Reuse**: shared list; MessageBubble embeds Markdown/CodeBlock + AuthedImage.

## Composer
- **Purpose**: compose & send an instruction; attach images; shows pending thumbnails + capability warning; interrupt control.
- **Variants/states**: enabled/disabled(stopped/offline)/busy(sending, optimistic echo); image-enabled vs warn-won't-send; steer vs prompt.
- **Surfaces**: runtime, assistant. **Reuse**: Textarea + Button + AttachmentThumb + ErrorBanner(compose-error).
- **Step-1 fix**: runtime + assistant now reference the one Composer.

## ApprovalCard (inline approve/deny)
- **Purpose**: inline, prominent decision card for a pending request — approve / deny, no burial.
- **Variants**: permission request (runtime), assistant action confirm (delete mesh), channel sender approve/revoke, device bootstrap/approve. Red-count Badge linkage.
- **States**: pending / resolving(busy) / resolved.
- **Surfaces**: runtime(transcript inline), assistant(inline), channels(sender inbox), device-auth(bootstrap).
- **Step-1 fix**: runtime "permission card" + assistant "confirm card" + channels "approve/revoke" unified to ApprovalCard (variants).

## AttachmentCard + AuthedImage
- **Purpose**: render a published artifact in-transcript — image (AuthedImage: Bearer-fetch → blob) or document (link → file-viewer).
- **Variants**: image vs doc; `artifact:` / `artifact://owner` resolution; loading/error.
- **Surfaces**: runtime, assistant, file-viewer(AuthedImage). **Reuse**: RouteLink(viewer) + AuthedImage + Lightbox.

## Lightbox
- **Purpose**: full-view image overlay (zoom). **Surfaces**: runtime, assistant, file-viewer. **Reuse**: Modal/overlay + AuthedImage.

## Markdown / CodeBlock
- **Purpose**: render markdown prose + fenced code (mono, highlighted). Code/ID/transcript = mono (font strategy, phase1 §1.1).
- **Surfaces**: transcript, file-viewer, charters. **Reuse**: in MessageBubble, file-viewer body, AttachmentCard(doc).

## Change / review log
- 2026-06-20 — created (Step 2). Composer + ApprovalCard unifications back-applied to Step 1.
