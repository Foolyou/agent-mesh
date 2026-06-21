# UI coverage map — index, state vocabulary & surface inventory (Phase A)

**Purpose.** Make the design scope **exhaustive** before any further mockups or Step 7
implementation. This directory is the *completeness gate*: a scannable map of every
surface × every function × every state, so the user can spot missing pages, missing
controls, or missing states. It is **docs/design only** — no high-fidelity mockups,
no implementation.

**How to read.** Start here for the route/IA inventory, the canonical **state
vocabulary** (the matrix columns every surface file uses), and the surface list with
its **exists-today vs net-new** marking. Then open the per-surface file for that
surface's function/control checklist and its function × state matrix.

Sources: Step 1 interaction docs (`../interaction/00-index.md` + 12 page docs),
Step 2 components (`../components/`), Step 3/4 tokens & cross-review (`../tokens/`,
`../04-cross-review.md`), and a current-repo capability audit (so existing behavior
isn't missed). Inputs of record per surface are listed in that surface's file.

---

## Canonical state vocabulary (matrix columns)

Every per-surface **function × state** matrix uses this column set. `—` = not
applicable to that function; `✓` = designed; `△` = partial / deferred (note why).

| Column | Meaning |
|---|---|
| **empty** | No data yet (no meshes/agents/issues/devices/…) — first-run / zero-state. |
| **loading** | Snapshot/fetch in flight — skeletons/spinners. |
| **populated** | Normal steady state with data. |
| **error** | Load/mutation failed — inline ErrorBanner + retry. |
| **permission** | Awaiting approval, OR an action the actor may not perform (hidden/disabled + reason). Covers device-auth `unauthorized` where relevant. |
| **busy/resolving** | A mutation/action in flight — optimistic echo + disabled control + spinner; includes CAS-409 reconcile. |
| **offline/disconnected** | WS/connection lost — last-known view + reconnecting; mutations disabled. |
| **boundary/scale** | 0 / 1 / N / very-large (virtualized) / long-text / overflow / truncation / many-labels / deep-tree edge cases. |
| **desktop** | Desktop treatment present & specified. |
| **mobile** | Mobile treatment: full / simplified(△) / deferred-by-design(△ with reason). |

Status-chip vocabulary (shared, from `../interaction/00-index.md`):
`ready→success ●` · `working→info/accent ▶` · `blocked→danger ■` · `idle→idle ○` ·
`done→success ✓` · `attention→warning !`.

**Net-new vs existing marker** (used per function): **[E]** = existing capability in
the shipped app today (design documents/redesigns it); **[N]** = net-new design (no
current implementation). Every surface file marks each function/control [E] or [N].

---

## Route / IA inventory

IA priority (locked, Step 0): **A 运行态 (runtime) > C 看板 (board) > B 管理 (management)**.
Default landing = runtime of default mesh. Real `<a href>` + History API + SPA
catch-all (after `/api`,`/ws`). Topbar folds theme/lang/auth into `设置▾`; management
surfaces under `管理▾`.

| # | Surface | Route(s) | Coverage file | Backing (repo) | Status |
|---|---|---|---|---|---|
| 01 | App shell / global nav | frame for all; `/` → default mesh runtime | `01-app-shell.md` | web server SPA, mesh list/snapshot, lifecycle start/stop/restart (API + `mesh` CLI) | [E] chrome+meshes; [N] redesigned adaptive shell |
| 02 | Runtime (A) | `/mesh/<m>` · `/mesh/<m>/agent/<a>` | `02-runtime.md` | gateway WS snapshot, agents/topology, permissions (`permission.*`), composer, interrupt/restart | [E] |
| 03 | Board (C) | `/mesh/<m>/board` · `/mesh/<m>/board/issue/<N>` · `?view&status&label&assignee&epic&sort&q` | `03-board.md` | `board.ts` / `board_*` MCP / `boards/<mesh>.json` / lifecycle auto-reflow / `BoardPanel.tsx` | [E] |
| 04 | New mesh builder | `/mesh/new` | `04-new-mesh.md` | mesh create API, `meshes/*.json`, harness/model selection | [E] |
| 05 | Mesh Assistant (B) | `/assistant` | `05-assistant.md` | assistant conversation + mesh-build tools | [E] |
| 06 | Harnesses | `/harnesses` | `06-harnesses.md` | harness probe (`HarnessPanel.tsx`), version lines, install/upgrade, running-old-version agents | [E] |
| 07 | Channels / Feishu + sender approval | `/channels` | `07-channels.md` | `src/channels/*`, `channels/feishu.json`, lark in/out, device-auth allowSenders enrollment | [E] |
| 08 | Doctor / system health + ps | `/doctor` | `08-doctor-system.md` | doctor checks, `mesh ps`, daemon/orphan diagnostics | [E] |
| 09 | Settings | `/settings` | `09-settings.md` | theme×accent runtime (`themes.ts`), language/i18n, device/auth management, default-view/device prefs | [E] theme/lang/devices; [N] default-view/device prefs |
| 10 | Notifications center | `/notifications` | `10-notifications.md` | server-side persistent notifications (per ui-redesign §1.4) | [N] (designed; not yet implemented) |
| 11 | File / artifact viewer | `/mesh/<m>/agent/<a>/artifact/<file>` | `11-file-viewer.md` | artifact serving, `AuthedImage`, FileViewer, images/lightbox, composer pending images | [E] |
| 12 | Device-auth (pre-auth gate) | any route while unauthorized | `12-device-auth.md` | device-code enrollment, token gate, CLI approve, `auth-store`/`auth-codes` | [E] |
| 13 | Global states (login/connection/offline/error/404) | cross-cutting | `13-global-states.md` | WS connect/reconnect, gate 401, SPA 404, boot probe | [E] connection/auth; [N] unified offline/error treatment |

> Mesh lifecycle controls (start/stop/restart) are cross-cutting: enumerated under
> **01 app-shell** (topbar/nav affordances) and **02 runtime** (mesh start/stop CTA),
> backed by the shipped start/stop/restart API + `mesh start|stop|restart` CLI.

---

## Surface inventory & organization (page count)

**14 coverage files**: this index + **13 per-surface files** (01–13 above). Each
per-surface file contains: (1) scope/routes + desktop/mobile treatment + exists/net-new;
(2) function/control/action checklist (every button/filter/search/sort/bulk/approval/
lifecycle/harness/channel/device/image/link/deep-link relevant); (3) function × state
matrix (columns above); (4) explicit [E]/[N] marks; (5) change log + sources read.

**Commit plan (this Phase A artifact):**
1. **(this commit)** index + canonical state vocabulary + route/IA inventory + surface
   inventory/count.
2. Core surfaces: `01-app-shell`, `02-runtime`, `03-board`.
3. Admin/support surfaces: `04-new-mesh`, `05-assistant`, `06-harnesses`,
   `07-channels`, `08-doctor-system`, `09-settings`, `10-notifications`,
   `11-file-viewer`, `12-device-auth`, `13-global-states`.

Mobile is a column in every matrix (not separate files): **full** core (shell/runtime/
board/approvals/notifications/device-auth/settings-basic), **simplified** (assistant/
harnesses/channels/doctor), **deferred-by-design** (zoomable topology, kanban drag,
multi-pane, full new-mesh builder, deep harness install) — each marked △ with reason.

---

## Global mobile layout rule (Phase B user-review · C1)

A cross-cutting rule applied across **all 13** `/__ui-mockup` surfaces (documented centrally
here because it is global, not surface-specific; the mockup drives it off the explicit
`device==="mobile"` prop, **not** Tailwind `sm:` — the mobile frame is a fixed 390px element,
not a narrow viewport, so responsive prefixes evaluate against the tool's wide viewport):

1. On mobile, never force `primary label + status chip + trailing actions` into one row.
2. Mobile rows **stack**: row 1 = status dot/name/chip, row 2 = secondary info full-width,
   row 3 = actions in their own wrapping row.
3. Buttons never wrap internally (`whitespace-nowrap`); they move to a new row instead.
4. Section/frame headers with trailing actions **split** on mobile: title line first, actions
   on a separate line (right-aligned or full-width).

**C1 audit (all 13 mobile surfaces).** Touched: **06 harnesses** (rows: name+chip / version /
actions own row; self-install stacked), **08 doctor** (summary = counts line / copy+run action
row / version line; findings = id+severity / message / fixHint, never two-column), **07 channels**
(pending-senders header splits title / 设备授权↗; pending items stack + action row), **09 settings**
(device rows stack approve/revoke), **05 assistant** & **10 notifications** (headers wrap so
p2p/全部已读 drop to their own line). Audited-OK without change: 01 shell, 02 runtime (ops row +
focus controls already wrap), 03 board (cards/detail already stack), 04 new-mesh (already
mobile-aware), 11 file-viewer (header truncates), 12 device-auth (single centered card),
13 global-states (catalog stacked). No newly-discovered [E] capability/layout gaps.

---

## Shared docked ApprovalBar pattern (Phase B user-review · C2)

A cross-surface pattern (central note here because it's shared by runtime + assistant; the
mockup component is `ApprovalBar` in `UiMockup.tsx`). Approvals/confirmations are **never
inline in the transcript/conversation** — they render in a **fixed, composer-adjacent docked
bar** so they cannot scroll away:

- **Placement.** Transcript/conversation scrolls in its own region; a docked region at the
  bottom holds `jump-to-latest → ApprovalBar → Composer`. The approval bar sits immediately
  above the composer on both desktop and mobile.
- **FIFO.** Only the **oldest** approval renders in the bar; the rest are summarized as
  `还有 N 个待授权` (queue badge), mirrored by a right-side context approval-queue badge.
- **Long content.** The bar caps its content (`max-h-44` + `overflow-auto`) so a long
  approval can never push the composer offscreen (shown in the boundary state).
- **Mobile.** The bar stays above the composer/keyboard zone (higher priority than the text
  input); ordinary input remains available while an approval is pending.
- **Jump-to-latest** lives inside the docked region so the fixed approval+composer never
  hides it. Applied to: **02 runtime** (focus, write-file approval) and **05 assistant**
  (delete-mesh confirm).

---

## Open coverage questions (for prdmgr/user)

- **Notifications (10)** is designed but **not yet implemented [N]** — confirm it stays
  in scope for the coverage map (and eventual build) vs deferred.
- **Settings default-view/default-device preference [N]** — confirm this preference is
  in scope (Step 0 reserved it; no current persistence).
- **Assistant (B)** vs the per-mesh runtime composer: confirm `/assistant` is the single
  global build/assistant entry (Step 1 moved Assistant out of runtime).
- **p2p DM → Mesh Assistant** (device-auth phase ⑤, in progress in repo): confirm whether
  the coverage map should include a p2p-DM surface or fold it into channels/device-auth.
- Any surface the user wants **explicitly out of mobile scope** beyond the deferred list.

## Change log / sources read
- 2026-06-22 — **Step 7.5-B per-surface mobile C1 sweep** (audit-and-close over every
  `/bnw` surface at 390px). Global C1 rule applied at the shared `PanelFrame` level: the
  header (title/description + actions) **stacks on mobile** (actions full-width below the
  heading) and returns to one row at `lg` — this alone fixed the title char-wrap squeeze on
  runtime overview/focus, board detail, and every other surface header. Per-surface fixes:
  runtime overview/focus action clusters `flex-wrap` + `whitespace-nowrap` links (02);
  doctor findings detail drops to its own full-width row on mobile (08); notifications filter
  chips `flex-wrap` instead of overflow/clip (10). Surfaces audited clean (already encoded
  `lg:` rules in 7.4 / no cram): harnesses (06), channels (07), settings (09), new-mesh (04),
  assistant (05), file-viewer (11, path truncates), board list (03), device-auth gate (12).
  Old root UI untouched (`PanelFrame` is used only by `/bnw` + the guarded `__ui-*` galleries).
  Gates: tsc · full `bun test` · lint:tokens · server.smoke · bnw.e2e 23 · `/bnw × 9`
  desktop+mobile a11y 18/18. Screenshots refreshed for all affected mobile surfaces (+ new
  `bnw-runtime-focus-mobile.png`, `bnw-board-detail-mobile.png`).
- 2026-06-21 — created (Phase A, commit 1): coverage index + state vocabulary + route/IA
  inventory + surface inventory. Sources read: `../interaction/00-index.md` (route map,
  state vocab, mobile coverage); route lines of `../interaction/01..12`; repo capability
  knowledge (device-auth, board_*, channels/feishu, doctor/ps, harnesses, file-viewer/
  artifacts/images, mesh lifecycle CLI/API, themes, assistant, notifications-as-designed).
  Per-surface deep audits land with commits 2–3.
