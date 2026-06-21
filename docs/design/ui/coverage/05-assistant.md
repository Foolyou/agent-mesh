# 05 · Mesh Assistant (B) — coverage

**Scope / routes.** Central controller chat: create/manage/delete meshes by natural
language; separated from the runtime transcript (resolves the "two chat inputs"
confusion). Low-frequency management surface. `/assistant` (in 管理▾).
**Desktop/mobile.** Desktop: full-width chat + tool-call cards. Mobile: full-width chat
via 更多 → Assistant (works well); mesh-builder hand-offs use the mobile new-mesh form (04).
**Exists vs net-new.** [E] assistant conversation + mesh-build tools; [N] redesigned surface.
**Sources read.** `../interaction/05-mesh-assistant.md`; repo: `store.ts` assistant scope
(`assistant.status`, `assistant.capabilities` {image,harness}, assistant transcript fold,
`interruptAssistant`→`/api/assistant/interrupt`), default state `assistant.status="absent"`.

## Function / control / action checklist
- **Chat with Assistant** [E] — NL commands ("create a mesh that…", "delete scratch", "change project of router").
- **Read tool-call cards** [E] — create/delete/update-mesh actions + results.
- **Attach context** [E] — composer (image capability gated by `assistant.capabilities.image`).
- **Confirm destructive action** [E] — inline confirm card (e.g. delete mesh) → ApprovalCard.
- **Interrupt** [E] — `interruptAssistant`.
- **Assistant chat fullscreen toggle** [E] — `⊟`/`⊞` expands the assistant chat to fill the column (`Sidebar.tsx` `AssistantChat` `onToggleFull`). (audit #21)

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Chat / send command [E] | ✓(prompt suggestions) | ✓(spawning→disabled) | ✓(streaming) | ✓(absent→"not configured"+enable) | △(disabled if absent) | ✓(disabled+echo) | ✓(last-known+reconnect) | ✓(long convo virtualized) | ✓ | ✓(full-width) |
| Tool-call cards [E] | N/A | ✓ | ✓(create/delete/update) | ✓(tool error) | N/A | ✓(running) | ✓(stale) | ✓(many calls) | ✓ | ✓ |
| Attach context [E] | ✓ | △(disabled until ready) | ✓ | ✓ | △(image gated by capability) | ✓ | ✓(disabled) | ✓(image tray) | ✓ | ✓ |
| Confirm destructive [E] | N/A | N/A | ✓ | ✓(resolve failed) | ✓(the confirm) | ✓(resolving) | ✓(disabled) | N/A | ✓(inline card) | ✓(inline) |
| Interrupt [E] | N/A | N/A | ✓(while working) | ✓ | N/A | ✓(in flight) | ✓(disabled) | N/A | ✓ | ✓ |
| Chat fullscreen toggle [E] (audit #21) | ✓ | ✓ | ✓(expand/restore) | ✓ | N/A | N/A | ✓(last-known) | ✓(long convo fills) | ✓ | △(already full-width) |

> **p2p-DM note** (lead #683 assumption 4): the authorized-p2p-DM → Mesh Assistant path
> (device-auth phase ⑤, in-progress in repo) is folded here + channels/device-auth for
> now. Repo audit: no dedicated p2p surface yet → no independent coverage file; revisit if it ships.

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/05-mesh-assistant.md`;
  `store.ts` assistant scope (status/capabilities/transcript/interruptAssistant).
- 2026-06-21 — backward-consistency completion (audit `14`): +assistant chat fullscreen
  toggle (#21). `Sidebar.tsx` `AssistantChat` `onToggleFull`.
