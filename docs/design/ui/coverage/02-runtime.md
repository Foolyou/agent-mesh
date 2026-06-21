# 02 · Runtime view (A) — coverage

**Scope / routes.** The operational cockpit for one mesh: all-agent topology overview,
focused-agent transcript, instruction composer, inline permission approvals, agent
controls. `/mesh/<m>` (runtime, default) · `/mesh/<m>/agent/<a>` (focused agent).
**Desktop/mobile.** Desktop: topology overview (nodes + status + mail edges) + focused
transcript + bottom composer + collapsible right context (activity/mail). Mobile:
agent card list (pending approvals pinned on top) → tap → focused transcript + composer;
zoomable topology canvas is desktop-only (△).
**Exists vs net-new.** [E] across the board (topology, transcript stream, composer with
images, approvals, interrupt/restart/new-session, start/stop). [N] = the redesigned
two-axis layout + pinned-approval mobile treatment.
**Inputs/sources read.** `../interaction/02-runtime-view.md`; repo: `store.ts`
(`steerAgent`→`/agents/<a>/steer`, `resolvePermission`→`/permissions/<r>/resolve`,
`interruptAgent`→`/agents/<a>/interrupt`, `newAgentSession`→`/agents/<a>/session`,
`newAllSessions`→`/session`, `permission.add/remove` folds), `MeshDetail.tsx`,
`Sidebar.tsx`, `Transcript.tsx`/`VirtualTranscript.tsx` (+ measurement cache,
virtualized scroll), `mesh-canvas` (topology), lifecycle API/CLI.

## Function / control / action checklist
- **Topology overview** [E] — agent nodes + status chips + mail edges; click node → focus; `⤢ expand` zoomable canvas (desktop-only).
- **Pending-approval indicators** [E] — red-dot/count on node + overview; mobile pins approvals atop the card list.
- **Focused transcript** [E] — streamed messages / thoughts / tool calls / mail / attachments / compact / divider; virtualized (`VirtualTranscript.tsx`).
- **Composer (send instruction)** [E] — text + attach images (pending-image tray); `sendPrompt`/`steerAgent`.
- **Steer (interject while working)** [E] — `steerAgent` `/steer`.
- **Inline ApprovalCard (approve/deny)** [E] — `resolvePermission` `/permissions/<r>/resolve`; highest-priority surface.
- **Interrupt agent** [E] — `interruptAgent` `/agents/<a>/interrupt`.
- **New session / restart agent** [E] — `newAgentSession` `/agents/<a>/session`; `newAllSessions` `/session`.
- **Start / stop mesh** [E] — lifecycle API/CLI; stopped→Start CTA, composer disabled.
- **Right context (activity / mail / topology detail)** [E] — per selected object; collapsible.
- **Agent card list (mobile)** [N-redesign] — status + pending-approval badge; tap → focus.
- **Deep links** [E] — `/mesh/<m>` overview, `/mesh/<m>/agent/<a>` focus.

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Topology overview [E] | ✓(stopped→idle nodes) | ✓(spawning) | ✓(live) | ✓(node blocked) | ✓(red-dot on node) | ✓(restart in flight) | ✓(last-known+reconnect) | ✓(many agents→zoom/scroll) | ✓(zoomable canvas) | △(cards replace canvas) |
| Pending-approval indicator [E] | N/A(none) | ✓ | ✓(count) | ✓ | ✓(prominent) | ✓(resolving) | ✓(stale) | ✓(N approvals) | ✓ | ✓(pinned top) |
| Focused transcript [E] | ✓(no messages) | ✓(skeleton) | ✓(streaming) | ✓(inline error+retry) | ✓(approval card inline) | ✓(optimistic echo) | ✓(last-known+reconnecting) | ✓(virtualized; long text) | ✓ | ✓ |
| Composer (send) [E] | ✓(prompt to type) | △(disabled until ready) | ✓ | ✓(send failed+retry) | △(disabled if unauth) | ✓(disabled+spinner) | ✓(disabled offline) | ✓(long text; image tray N) | ✓ | ✓ |
| Steer [E] | N/A | N/A | ✓(while working) | ✓ | N/A | ✓ | ✓(disabled) | N/A | ✓ | ✓ |
| Inline ApprovalCard [E] | N/A | N/A | ✓ | ✓(resolve failed) | ✓(the core state) | ✓(resolving) | ✓(disabled) | ✓(multiple pending) | ✓(in transcript) | ✓(pinned) |
| Interrupt [E] | N/A | N/A | ✓(while working) | ✓ | △(perm) | ✓(in flight) | ✓(disabled) | N/A | ✓ | ✓ |
| New session / restart [E] | ✓(idle) | ✓ | ✓ | ✓(fail+retry) | △(perm) | ✓(spinner) | ✓(disabled) | ✓(restart-all N agents) | ✓ | ✓ |
| Start/stop mesh [E] | ✓(stopped→Start CTA) | ✓(starting) | ✓(running) | ✓(fail+retry) | △(perm) | ✓(in flight) | △(disabled offline) | N/A | ✓ | ✓ |
| Right context [E] | ✓ | ✓ | ✓ | ✓ | N/A | N/A | ✓ | ✓(long activity/mail scroll) | ✓(collapsible) | △(via agent overflow) |
| Agent card list (mobile) [N] | ✓(no agents) | ✓ | ✓ | ✓ | ✓(pinned approvals) | ✓ | ✓(last-known) | ✓(N agents scroll) | N/A(desktop=topology) | ✓ |
| Deep links [E] | ✓ | ✓ | ✓ | ✓(bad agent→fallback) | ✓(unauth→gate) | N/A | ✓ | N/A | ✓ | ✓ |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 2). Sources: `../interaction/02-runtime-view.md`;
  `store.ts` (steer/resolvePermission/interrupt/newSession + permission folds),
  `MeshDetail.tsx`, `Sidebar.tsx`, `Transcript.tsx`/`VirtualTranscript.tsx`, mesh-canvas,
  lifecycle API/CLI.
