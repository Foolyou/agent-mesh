# UI redesign — Step 1 interaction design · index & conventions

Pipeline: `ui-design-pipeline` SKILL, **Step 1 only** (page & interaction design, low-fidelity). Branch `task/ui-redesign-pipeline`, base main `5e12e5c`.
This is the **gate artifact** for prdmgr/user to review page & state coverage before Step 2 (component inventory). Fidelity is intentionally **low** — structure & interaction flow, not pixels. High-fidelity Tailwind mockups come in Step 6.

Step 0 inputs (read, treated as settled — not re-litigated): `docs/design/ui-redesign.md`, `ui-redesign-toolkit.md`, `ui-redesign-phase1.md`, `ui-redesign-tailwind.md`.

## Locked ground rules (from prdmgr/user — apply, don't re-ask)
- **Stack:** 100% Tailwind final, preflight on, `@theme`→runtime CSS vars, no final legacy `theme.css`.
- **Themes:** 3×3 = mode {Dark·Slate, Light·Cool, Eye-care·Warm} × accent {Teal, Ember, Azure} + custom palette; WCAG AA required (tokens are Step 3, not here).
- **Routing:** real `<a href>` + History API + server catch-all SPA fallback (after `/api`/`/ws`); comprehensive routes (below).
- **Defaults/layout:** default landing = runtime; reserve default-view preference; topbar folds theme/lang/auth into `设置▾`; system sans.
- **Device split:** mobile core = **mesh status / conversation / approvals**; other surfaces simplified or deliberately deferred.

## Shared vocabulary (used by every page doc — keep consistent)
**Status chip** (the signature, phase1 §1.4): `dot + icon + label`, semantic color. Canonical set:
`ready`(ok ●) · `working`(info ▶) · `blocked`(bad ■) · `idle`(off ○) · `done`(good ✓) · `attention`(warn !).
**State vocabulary** (each page enumerates the relevant subset): `empty` · `loading` · `populated` · `error` · `permission` (awaiting approval) · `busy` (action in flight) · `offline` (disconnected) · `unauthorized` (device-auth).
**Device-split principle:** desktop = full control surface; mobile = touch-reflowed core (status/conversation/approvals), deep/secondary surfaces simplified or deferred — never a folded desktop.

## Route map (comprehensive; see phase1 §3.2)
| Surface | Route | Doc |
|---|---|---|
| App shell / chrome | (frame for all) | `01-app-shell.md` |
| Default landing | `/` → runtime of default mesh | `01-app-shell.md` |
| Runtime (A) | `/mesh/<m>` · `/mesh/<m>/agent/<a>` | `02-runtime-view.md` |
| Board (C) | `/mesh/<m>/board` · `/mesh/<m>/board/issue/<N>` | `03-board-view.md` |
| New mesh | `/mesh/new` | `04-new-mesh-builder.md` |
| Mesh Assistant | `/assistant` | `05-mesh-assistant.md` |
| Harnesses | `/harnesses` | `06-harnesses.md` |
| Channels (Feishu) | `/channels` | `07-channels.md` |
| Doctor / system health | `/doctor` | `08-doctor-system.md` |
| Settings (theme/lang/auth/devices) | `/settings` | `09-settings.md` |
| Notification center | `/notifications` | `10-notifications.md` |
| File / artifact viewer | `/mesh/<m>/agent/<a>/artifact/<file>` | `11-file-viewer.md` |
| Device-auth (pre-auth gate) | any route while unauthorized | `12-device-auth.md` |

## Page × state coverage matrix
✓ = covered in that page's doc · — = N/A
| Page | empty | loading | populated | error | permission | busy | offline | unauthorized |
|---|---|---|---|---|---|---|---|---|
| 01 app-shell | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ |
| 02 runtime | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 03 board | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 04 new-mesh | ✓ | — | ✓ | ✓ | — | ✓ | — | — |
| 05 assistant | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 06 harnesses | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| 07 channels | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| 08 doctor | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| 09 settings | — | ✓ | ✓ | ✓ | — | ✓ | — | — |
| 10 notifications | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | — |
| 11 file-viewer | — | ✓ | ✓ | ✓ | — | — | — | — |
| 12 device-auth | — | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ |

## Mobile coverage
Core (full mobile design): app-shell (bottom tabs) · runtime (agent cards + conversation) · board (list/detail) · approvals (surfaced in runtime) · notifications · device-auth · settings(basic).
Simplified on mobile: assistant (chat works; mesh-builder simplified), harnesses (read + reprobe; install guided), channels/doctor (read-only summaries).
Deferred on mobile (desktop-only, by design): zoomable topology canvas, kanban drag, multi-pane, new-mesh full builder, deep harness install flows. (spec §1.7)

## Open questions
None blocking for Step 1 — Step 0 docs + locked rules cover product scope. Any scope gap surfaces as `[REQ]` to lead, not a silent decision.

## Change / review log
- 2026-06-20 — created (Step 1 interaction design): index + 12 page docs. Awaiting prdmgr/user gate review.

## Step 2 addendum (2026-06-20)
Component vocabulary unified in Step 2 — see `../components/`. The shared-vocabulary section above (status chips, state words) is now backed by concrete component specs; per-page one-offs (mesh/agent/task/device/harness/notification rows, permission/confirm cards, panels, tabs) were unified into StatusListRow / ApprovalCard / PanelFrame / SegmentedControl and each page doc carries a "Components used (Step 2)" cross-link.

## Step 3 + Step 4 addendum (2026-06-20)
- **Step 3 tokens** live in `../tokens/` (token model, the 3×3 palette values, AA evidence, themed component drafts). Status-chip semantics here map to status tokens (`ready→ok`, `working→info`/`accent`, `blocked→bad`, `idle→off`, `done→good`, `attention→warn`); accent is the brand/"thinking" token.
- **Board correction** (milestones were a maturity benchmark, not a feature): the board view (`03-board-view.md`) uses GitHub-Issues maturity over the existing data model only, with **Epic** (not milestones) as the grouping primitive. The route map + coverage matrix above were aligned in Step 4 (issue-detail route `/board/issue/<N>`; board has a `permission` state).
- **Step 4 cross-review record**: `../04-cross-review.md` (Steps 1–3 mutual-consistency pass + the back-edits it triggered).
