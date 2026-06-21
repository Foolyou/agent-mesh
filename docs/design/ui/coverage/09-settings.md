# 09 · Settings — coverage

**Scope / routes.** App preferences & access: theme (mode × accent + custom palette),
language, default-view/default-device preference, device authorization management
(approved/pending/revoked, bootstrap). `/settings` (topbar 设置▾).
**Desktop/mobile.** Desktop: all groups. Mobile: stacked groups via 更多 → 设置;
appearance + language + default-view fully usable; device review + approve/revoke;
custom-palette advanced editor simplified (△).
**Exists vs net-new.** [E] theme×accent runtime, language/i18n, device review/revoke;
[N] default-view/default-device preference (Step 0 reserved; no persistence yet).
**Sources read.** `../interaction/09-settings.md`; repo: `Theme.tsx`, `themes.ts`
(mode×accent compose + persistence keys `mesh.theme.mode`/`accent`, custom palette),
`i18n.ts` (language), device-auth (`device-auth.ts` `submitBootstrap`
`/api/auth/device/bootstrap`; device list/approve/revoke; host-CLI authoritative).

## Function / control / action checklist
- **Theme mode** [E] — Dark·Slate / Light·Cool / Eye-care·Warm.
- **Accent** [E] — Signal Teal / Ember / Fleet Azure.
- **Custom palette editor** [E] — live edit; tolerant of transient invalid hex.
- **Language** [E] — i18n switch.
- **Default landing view (runtime/board)** [N] — preference; default-device too [N].
- **Device management** [E] — list approved/pending/revoked, see this device, revoke; approve (host-CLI authoritative — WebUI review/revoke + read pending).
- **Mint bootstrap token** [E] — host-side echo; first-device bootstrap.

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable
(No meaningful **empty** for the settings groups themselves → N/A; device list can be empty.)

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Theme mode [E] | N/A | ✓ | ✓(current reflected) | ✓ | N/A | ✓(applying) | ✓(local, works offline) | ✓(9 mode×accent combos) | ✓ | ✓ |
| Accent [E] | N/A | ✓ | ✓ | ✓ | N/A | ✓ | ✓(local) | ✓(per-mode accent) | ✓ | ✓ |
| Custom palette [E] | N/A | ✓ | ✓ | ✓(invalid hex tolerated, no throw) | N/A | ✓(saving) | ✓(local) | ✓(all token fields) | ✓ | △(simplified editor) |
| Language [E] | N/A | ✓ | ✓ | ✓ | N/A | ✓ | ✓(local) | ✓(long strings reflow) | ✓ | ✓ |
| Default view/device [N] | N/A | ✓ | ✓ | ✓(save failed+retry) | N/A | ✓(saving) | △(disabled offline) | N/A | ✓ | ✓ |
| Device management [E] | ✓(only this device) | ✓(fetch→skeleton) | ✓(approved/pending/revoked) | ✓(action failed) | ✓(approve=host-CLI authoritative; WebUI review/revoke) | ✓(approve/revoke in flight) | △(disabled offline) | ✓(N devices) | ✓ | ✓(review+approve/revoke) |
| Mint bootstrap [E] | N/A | ✓ | ✓(host echo) | ✓ | △(operator) | ✓ | △(disabled) | N/A | ✓ | △(host-side) |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 3). Sources: `../interaction/09-settings.md`;
  `Theme.tsx`, `themes.ts` (compose + persistence + custom palette), `i18n.ts`,
  `device-auth.ts` (bootstrap; device mgmt — host CLI authoritative per `12`).
- Open (carried): default-view/default-device pref is [N] (lead #683 assumption 2).
