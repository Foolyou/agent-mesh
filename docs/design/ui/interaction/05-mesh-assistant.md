# Mesh Assistant — interaction (Step 1)

Route: `/assistant` (in 管理▾). Inputs: ui-redesign.md §1.4/§1.5 (Assistant moved out of runtime into management).

## Function
The central controller chat: create/manage/delete meshes by natural language (the conductor). Deliberately separated from the runtime focused-transcript so the "two chat inputs" confusion is resolved — Assistant is a low-frequency management surface, not in the runtime cockpit.

## Core user actions
- Chat with the Assistant; issue NL commands ("create a mesh that…", "delete scratch", "change project of router"); read its tool actions/results; attach context.

## States
- **empty**: no conversation yet → prompt suggestions ("Create a mesh…", "List meshes").
- **loading**: assistant spawning → "starting" chip; composer disabled.
- **populated**: conversation streaming (messages + tool-call cards for create/delete/update mesh).
- **permission**: assistant action needs confirm (e.g. delete mesh) → inline confirm card.
- **busy**: prompt in flight → disabled send + optimistic echo.
- **error / absent**: assistant unavailable → notice "Assistant not configured/absent" + how to enable; chat disabled.
- **offline**: last-known + reconnecting.

## Desktop
```
┌ Mesh Assistant ───────────────────────────────────────────┐
│ transcript (messages + tool cards: create/delete/update)   │
│   [tool] create_mesh "scratch" (completed)                 │
│   ┌ confirm: delete "scratch"?  approve / cancel ┐         │
│ ┌ composer: ask the assistant… + attach ─────────────────┐ │
└────────────────────────────────────────────────────────────┘
```
- Single full-width conversation page; same chip/transcript language as runtime, but app-level (not mesh-scoped).

## Mobile
- Full-width chat (works well on mobile); reachable via 更多 → Assistant. Tool-confirm cards inline. Mesh-builder hand-offs simplified.

## Mobile divergence
Chat fully supported; any builder-style multi-field actions it triggers fall back to the simplified mobile new-mesh form (doc 04). (spec §1.7)

## Open questions
None.

## Change / review log
- 2026-06-20 — created (Step 1).
