# 10 · Notifications center — coverage

**Scope / routes.** App-level (cross-mesh) system-message aggregator: harness-upgrade
prompts, frontend self-update, connection/service status, system alerts. NOT transcript,
NOT a mesh's local activity/mail. `/notifications` (topbar 🔔; 更多 on mobile).
**Desktop/mobile.** Desktop: drawer/list. Mobile: full-screen list via 更多 → 通知
(core on mobile — status awareness matters on phone).
**Exists vs net-new.** **[N]** — designed surface; server-side persistence/unread/history
model is phase 4 (not yet implemented). Today only ad-hoc notices exist (e.g. harness
upgrade prompts in `HarnessPanel.tsx`); there is **no notifications center**.
**Sources read.** `../interaction/10-notifications.md` (spec §1.8); repo audit: no
notifications-center module/endpoint found; `HarnessPanel.tsx` is the only current
"notification"-style notice → confirms [N].

## Function / control / action checklist (all [N] unless noted)
- **Unread count on 🔔 entry** [N] — badge from server store.
- **Open list/drawer** [N].
- **Read an item + follow its action** [N] — e.g. refresh / open harnesses (the action targets are [E]).
- **Mark read** [N].
- **Review history** [N].

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Unread count [N] | ✓(0→no badge) | ✓ | ✓(count) | ✓(stale) | N/A | N/A | ✓(stale count) | ✓(99+ overflow) | ✓ | ✓(in 更多) |
| Open list/drawer [N] | ✓("all caught up") | ✓(skeleton) | ✓(newest-first) | ✓(load failed+retry) | N/A | N/A | ✓(shows connection-lost item; last-known) | ✓(long history virtualized) | ✓(drawer) | ✓(full-screen) |
| Read + follow action [N] | N/A | ✓ | ✓(type icon+title+time+read state) | ✓(action target error) | △(action may be gated) | ✓(navigating) | ✓(action disabled if needs net) | ✓(long title trunc) | ✓ | ✓ |
| Mark read [N] | N/A | N/A | ✓ | ✓(persist failed) | N/A | ✓(in flight) | △(disabled offline) | ✓(mark-all N) | ✓ | ✓ |
| Review history [N] | ✓(none) | ✓ | ✓ | ✓ | N/A | N/A | ✓(last-known) | ✓(large history) | ✓ | ✓ |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/10-notifications.md`;
  repo audit (no center today → whole surface [N]; persistence/unread/history = phase 4).
- Open (carried): notifications stays in scope as [N] (lead #683 assumption 1). Membership
  (which message classes are global vs mesh-local) + read/history data model = phase-4 detail.
