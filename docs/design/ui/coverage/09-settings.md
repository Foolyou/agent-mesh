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
- 2026-06-21 — Phase B Step 2 mockup (`UiMockup.tsx`): the Settings surface built in the
  guarded `/__ui-mockup` (`?surface=settings`) — a standalone grouped panel frame (route
  `/settings`, 设置▾ / mobile 更多). Appearance group: theme mode (3) + accent (3)
  SegmentedControls that drive the live compose() runtime, a 3×3 mode×accent preview grid
  (boundary), and a custom-palette advanced editor (token hex fields tolerant of invalid
  hex — no throw, aria-invalid). Language group (en/zh, technical nouns kept English).
  Preferences group: default landing view + default device ([N]). Device authorization
  group: device list (this/approved/pending/revoked) with approve (host-CLI authoritative —
  disabled in permission) + revoke (WebUI) + mint bootstrap token. States: empty→device
  list "only this device", loading→skeleton, populated, error→invalid-hex tolerated +
  device action failed, permission→approve host-CLI-authoritative note (approve disabled,
  revoke available), busy→apply/save/resolve in flight, offline→appearance/language local
  (still work) + device mgmt/prefs disabled, boundary→9 mode×accent grid + many devices.
  Desktop = all groups; mobile = stacked (custom-palette simplified per matrix △). Grounded
  in `themes.ts` (MODES×ACCENTS compose + custom palette) + `i18n.ts` (Lang en/zh) +
  `device-auth.ts` (DeviceAuthPhase / submitBootstrap; host-CLI authoritative). No
  additional [E] capability beyond the checklist found. Index (`?index=1`) gains the 09 row.
  Fixture-only, true C5–C8, v2 tokens.
- 2026-06-21 — amend (lead review): align offline to the matrix △ — the default-view /
  default-device `SegmentedControl`s now pass per-option `disabled` when `state="offline"`
  (server-persisted prefs can't save offline), while appearance/theme and language stay
  enabled (local). SSR + e2e assert the offline pref options are disabled and theme mode
  stays enabled.
