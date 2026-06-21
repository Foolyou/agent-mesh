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
- **Session fullscreen toggle** [E] — `⊞ full`/`⊟ exit` expands the conversation pane / restores split (`MeshDetail.tsx` `onToggleFull`, desktop). (audit #9)
- **Per-agent runtime selectors** [E] — mode / model / effort / kimi-thinking live selectors (`Mode/Model/Effort/KimiThinkingControl`). (audit #10)
- **Wake cold/lazy agent** [E] — `store.wakeAgent` "wake" (only when cold). (audit #11)
- **Context/health usage** [E] — `ContextUsageChip`/`ContextWaterline` (`./health`), near-limit warning, `silent-stop-badge`. (audit #12)
- **Pending-turn queue** [E] — `ChatPane.tsx` `queue-box`/`queueNavState` (prev/next nav) + `removeQueued`. (audit #13)
- **Transcript expanders** [E] — thought (`setOpen`), tool-call input/output/files (`setOverride`), long mail (`mail-expand-btn`). (audit #14)
- **Jump-to-bottom + load-older** [E] — `jump-bottom`/`jumpToBottom`, `onLoadOlder` (`VirtualTranscript.tsx`). (audit #15)
- **Topology canvas controls** [E] — `⤢` opens `MeshCanvas.tsx`: draggable/resizable agent windows, per-window stop/wake, actions menu, Esc close. (audit #16)
- **Live add agent / add edge** [E] — `MeshDetail.tsx` `agent-add`/`edge-add` mutate a running mesh's topology. (audit #17, owning surface = runtime per triage)
- **Start strategy + new-all-sessions** [E] — `start-session-sel` (resume/fresh) before start; `newAllSessions` two-click reset. (audit #18)
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
| Session fullscreen [E] (audit #9) | ✓ | ✓ | ✓(toggle full/split) | ✓ | N/A | N/A | ✓(last-known) | ✓(long transcript fills) | ✓ | N/A(no split to expand) |
| Runtime selectors mode/model/effort/kimi [E] (audit #10) | N/A(stopped) | ✓(advertised) | ✓(live change) | ✓(change failed+retry) | △(disabled if unauth/not-runtime) | ✓(applying) | △(disabled offline) | N/A | ✓ | ✓ |
| Wake cold/lazy agent [E] (audit #11) | ✓(cold→Wake) | ✓(waking) | N/A(already live) | ✓(fail+retry) | △(perm) | ✓(in flight) | △(disabled offline) | N/A | ✓ | ✓ |
| Context/health usage [E] (audit #12) | N/A(no usage) | ✓ | ✓(chip+waterline) | ✓ | N/A | ✓(updating) | ✓(stale) | ✓(near-limit warning) | ✓ | ✓(compact chip) |
| Pending-turn queue [E] (audit #13) | N/A(empty queue) | ✓ | ✓(nav prev/next) | ✓ | △(perm to remove) | ✓(while working) | ✓(last-known) | ✓(many queued→nav) | ✓ | ✓ |
| Transcript expanders [E] (audit #14) | N/A | ✓ | ✓(thought/tool/mail) | ✓ | N/A | ✓ | ✓(last-known) | ✓(huge tool output) | ✓ | ✓ |
| Jump/load-older [E] (audit #15) | N/A(empty) | ✓(load-older) | ✓(jump-bottom) | ✓(load failed+retry) | N/A | ✓ | ✓(last-known) | ✓(virtualized long history) | ✓ | ✓ |
| Topology canvas controls [E] (audit #16) | ✓(idle nodes) | ✓ | ✓(drag/resize/stop/wake) | ✓(node blocked) | △(actions perm-gated) | ✓(in flight) | △(read last-known) | ✓(many windows pan) | ✓(overlay) | N/A(cards, no canvas) |
| Live add agent/edge [E] (audit #17) | N/A(stopped) | ✓ | ✓(add to running) | ✓(fail+retry) | △(operator) | ✓(adding) | △(disabled offline) | ✓(dense graph) | ✓ | △(simplified) |
| Start strategy + new-all-sessions [E] (audit #18) | ✓(stopped→strategy) | ✓(starting) | ✓(new-all on live) | ✓(fail+retry) | △(perm) | ✓(in flight) | △(disabled offline) | ✓(N agents) | ✓ | ✓ |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 2). Sources: `../interaction/02-runtime-view.md`;
  `store.ts` (steer/resolvePermission/interrupt/newSession + permission folds),
  `MeshDetail.tsx`, `Sidebar.tsx`, `Transcript.tsx`/`VirtualTranscript.tsx`, mesh-canvas,
  lifecycle API/CLI.
- 2026-06-21 — backward-consistency completion (audit `14`): +session fullscreen (#9),
  +mode/model/effort/kimi selectors (#10), +wake (#11), +context/health usage (#12),
  +pending-turn queue (#13), +transcript expanders (#14), +jump/load-older (#15),
  +topology canvas controls (#16), +live add agent/edge (#17, runtime per triage),
  +start strategy/new-all-sessions (#18). `MeshDetail.tsx`/`ChatPane.tsx`/`MeshCanvas.tsx`/
  `Transcript.tsx`/`VirtualTranscript.tsx`/`health`.
- 2026-06-21 — Phase B Step 2 mockup补漏 (`UiMockup.tsx`): all of #9–#18 now rendered in
  the guarded `/__ui-mockup` runtime surface. New `runtime=full` (session fullscreen
  frame, ⊟ exit) and `runtime=canvas` (zoomable topology: draggable/resizable windows,
  per-window stop/wake/actions, zoom toolbar, Esc close) standalone desktop frames;
  focus gains selectors + context/health + queue + transcript expanders + load-older/
  jump + ⊞ full; overview gains start-strategy + add agent/edge + new-all + wake on the
  cold `kimi-cold` node. Mobile: full→focus, canvas→list (desktop-only per matrix).
  Also added a route-guarded navigation index (`?index=1`) skeleton.
