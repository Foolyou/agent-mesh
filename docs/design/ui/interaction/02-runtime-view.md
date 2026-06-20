# Runtime view (A) — interaction (Step 1)

Routes: `/mesh/<m>` (runtime, default) · `/mesh/<m>/agent/<a>` (focused agent). Inputs: ui-redesign.md §1.5/§1.7, phase1.md §2.

## Function
The operational cockpit for one mesh: see all agents at a glance (topology), focus one agent's conversation, send instructions, and approve permission requests inline. Default landing view.

## Core user actions
- Read topology overview (who's ready/working/blocked); click a node → focus that agent's transcript.
- Read the focused transcript; send an instruction via composer; attach images.
- Approve/deny a permission request inline; interrupt a working agent; new-session / restart an agent.
- Expand right context (topology detail / that agent's activity · mail) on demand.
- Start/stop the mesh.

## States
- **empty**: mesh defined but stopped → topology shows agents `idle`; main shows "mesh stopped — Start" CTA; composer disabled.
- **loading**: starting → agents `working`/spawning; transcript skeleton.
- **populated**: running; transcript streaming; topology live.
- **permission**: an agent requests approval → **inline, prominent** approve/deny card in the focused transcript + a red count badge on the topology node and the overview (spec §1.5). Highest-priority surface.
- **busy**: composer send / restart in flight → disabled control + spinner; optimistic echo of the sent message.
- **error**: agent dead / send failed → inline error in transcript + retry; topology node `blocked`.
- **offline**: connection lost → last-known transcript + "reconnecting"; composer disabled.

## Desktop
```
┌ runtime ───────────────────────────────────────────────┬ right context ──┐
│ topology overview (nodes + mail edges, status chips)    │ (on-demand)     │
│   ● router  ▶ codex-1  ■ opencode-1  …  [⤢ expand]      │ • topology      │
├─────────────────────────────────────────────────────────┤   detail        │
│ focused transcript — <agent> (default: router)          │ • activity      │
│   …streamed messages / tool calls / dividers…           │ • mail          │
│   ┌ permission: approve / deny  (when pending) ┐         │ (collapsible)   │
│ ┌ composer: instruction + attach ───────────────────────┤                 │
└─────────────────────────────────────────────────────────┴─────────────────┘
```
- Topology = global overview; node click → focuses transcript (one focus pane only — no multi-pane; spec §1.5). Router is just the first node.
- Inline approval lives in the transcript, not buried. Right context expands per selected object, collapsible.
- Single conversation entry (Assistant moved to `/assistant`).

## Mobile
```
┌ runtime (mesh status) ─────────────┐     tap card →  ┌ agent focus ───────┐
│ agent cards (status + ⚠ approvals) │  ───────────▶   │ <agent> transcript │
│  ▸ router    ● ready                │                 │  …messages…        │
│  ▸ codex-1   ▶ working   ⚠1         │                 │ ┌ approve/deny ┐    │
│  ▸ opencode-1 ■ blocked             │                 │ ┌ composer ────┐    │
│  (pending approvals pinned on top)  │     ◀ back      └────────────────────┘
└─────────────────────────────────────┘
```
- Replaces zoomable topology with an **agent card list** (status + pending-approval badge); tap → focused transcript + composer.
- **Pending approvals pinned to top** of the card list (core mobile job).

## Mobile divergence
Zoomable topology canvas is **desktop-only** (kept as a desktop strength); mobile uses cards. No right-context pane (activity/mail reachable via the agent's overflow). Core preserved: status / conversation / approvals (spec §1.7).

## Open questions
None.

## Change / review log
- 2026-06-20 — created (Step 1).
