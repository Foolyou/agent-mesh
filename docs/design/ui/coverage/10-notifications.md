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
- 2026-06-21 — Phase B Step 2 mockup (`UiMockup.tsx`): the Notifications center built in the
  guarded `/__ui-mockup` (`?surface=notifications`) — a standalone frame (route
  `/notifications`, topbar 🔔 / mobile 更多). All [N], fixture-only. Unread badge (99+
  overflow at boundary) + mark-all-read; newest-first list of notice items by class —
  harness upgrade / frontend self-update / connection-service / system alert / device-auth —
  each with type icon + title + detail + time + unread dot + a follow-action (nav to the [E]
  surfaces harnesses/doctor/settings/channels via LinkButton, or a local action like 刷新更新)
  + per-item mark-read; a history (已读) divider section. States: empty→"全部已读" + no badge
  + mark-all disabled, loading→skeleton, populated, error→load-failed+retry, busy→mark in
  flight, offline→pinned connection-lost item + last-known list + mark-read disabled,
  boundary→long title + 99+ + large history, permission→read-only note + gated device-class
  mark-read. Desktop = drawer/list; mobile = full-screen list. No existing [E] notifications-
  center capability exists (only ad-hoc `HarnessPanel.tsx` upgrade notices, already its own
  surface) → nothing new to flag. Index (`?index=1`) gains the 10 row. true C5–C8, v2 tokens.
- 2026-06-21 — amend (lead review): make the permission-state gated action real — in
  `state="permission"` the device-auth notice is surfaced as unread so its mark-read renders
  disabled (gated), while a non-device unread item's mark-read stays enabled. SSR + e2e now
  assert `mark read n4` is disabled and `mark read n1` is not.
