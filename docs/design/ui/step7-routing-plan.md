# Step 7 — URL routing foundation + phased migration plan

**Status:** planning/design only (docs-only). No `src/web/client` implementation in this
commit. This plan is the gate artifact for Step 7; real pages start only after it is
reviewed and explicitly released.

**Scope of Step 7 (overall):** turn the C1–C5–reviewed Step 6 mockups (guarded
`/__ui-mockup`, fixture-only) into the real, WS/store-wired console, behind a proper URL
router so every one of the 13 surfaces is a direct, deep-linkable, right-click/new-tab URL.

**Grounding:** every recommendation below was written after reading the real shipped code
(not the mockups). See **§5 Sources read**. Key facts were grep/Read-verified (the
verify-before-citing rule); the few cross-checked claims are marked ✔.

---

## 0. Where the app is today (the starting point)

- **Entry** (`index.tsx`): path-prefix branch — `/__ui-preview` → gallery, `/__ui-mockup`
  → mockups, everything else → `<Boot>` (the real console). No router; a literal
  `pathname.startsWith` switch. ✔
- **Boot/device-auth** (`Boot.tsx`, `device-auth.ts`): a **pre-auth gate** wraps the whole
  console. Token in `localStorage["mesh.deviceToken"]`, sent as `Authorization: Bearer`
  on every `/api/*`; the WS carries it as `?token=` (the only sanctioned URL-token). The
  gate is **route-agnostic** — it renders over whatever path you loaded; no URL parsing. ✔
- **App shell** (`App.tsx`): navigation is **React state + modals**, not URLs:
  - `selectedMesh` (persisted to `localStorage["mesh.selected"]`, NOT read from the URL),
    `selectedAgent`, `fullView` (`agent`/`assistant` fullscreen) — all `useState`. ✔
  - new-mesh / harnesses / Feishu / system are **modals** opened by booleans
    (`newMeshOpen`, `harnessOpen`, `feishuOpen`, `systemOpen`). ✔
  - The **only** URL-routed surface is the **file/artifact viewer**: `parseFileRoute()`
    matches `^/mesh/([^/]+)/agent/([^/]+)/(file|artifact)/(.+)$` off `window.location.pathname`,
    and App listens to `popstate` to re-derive it. ✔
- **Board** (`BoardPanel.tsx`): already does its **own** search-param routing —
  `parseBoardRoute(search)` / `serializeBoardRoute()` / a `popstate` listener /
  `history.pushState`. So a board sub-route already round-trips through the URL today. ✔
- **Server** (`server.ts`): the asset server maps `routes: { "/", "/mesh/*", "/__ui-preview",
  "/__ui-mockup" } → index.html`; any other path falls through to a `404`. The public
  server checks `/ws` → `/api/*` → `__ui-*` guard → asset fetch, and sets no-store
  cache-control for `/` and `/mesh/*`. **So `/mesh/<id>` deep links already serve the SPA**,
  but `/assistant`, `/harnesses`, `/doctor`, `/settings`, `/channels`, `/notifications`,
  `/mesh/new` would **404 on reload** today. ✔
- **RouteLink** (`ui/RouteLink.tsx`, shipped C5 component): a real `<a href>` that
  SPA-navigates on unmodified same-origin left-click via `spaTarget()` and falls back to
  native behavior (new-tab/middle-click/modifier/`target=_blank`/download/cross-origin).
  It pushes state and dispatches a synthetic `popstate`. **This is the migration primitive
  the whole router builds on; it already exists and is unit-tested.** ✔

**Implication:** we are not adding routing from zero. We have (a) RouteLink for link
interception, (b) two working hand-rolled route parsers (board search-params, file
pathname), (c) a server that already SPA-falls-back for `/` and `/mesh/*`. Step 7.0 is
mostly **generalizing** these three into one small router + widening the server fallback.

---

## 1. URL routing foundation design

### 1.1 URL scheme (all 13 surfaces)

Principle: **resource identity in the path** (deep-linkable, shareable, new-tab-able);
**ephemeral view-state in the query** (filters, kanban/list, fullscreen, canvas). Path
segments mirror the IA priority **A 运行态 > C 看板 > B 管理**.

| # | Surface | Canonical route | View-state (query) | Today |
|---|---------|-----------------|--------------------|-------|
| 01 | App shell / landing | `/` → redirect to default mesh runtime (`/mesh/<default>`) | — | `/`→index ✔ |
| 02 | Runtime A — overview | `/mesh/<id>` | — | served, but mesh read from localStorage not URL |
| 02 | Runtime A — focus (agent) | `/mesh/<id>/agent/<agentId>` | `?full=1` (session fullscreen, #9) | new |
| 02 | Runtime A — canvas | `/mesh/<id>/canvas` | — | new (was `topoOpen` state, #16) |
| 03 | Board C — list | `/mesh/<id>/board` | `?view=list\|kanban&status=&label=&assignee=&epic=&q=&sort=&group=epic` | board self-routes via search ✔ |
| 03 | Board C — detail | `/mesh/<id>/board/issue/<n>` | (filters preserved in query) | board self-routes ✔ |
| 04 | New-mesh builder | `/mesh/new` (create) · `/mesh/<id>/edit` (edit) | `?nmEditor=charter\|instructions` (expanded editor, #2) | modal today |
| 05 | Mesh Assistant B | `/assistant` | `?full=1` (chat fullscreen, #21) | inside Sidebar today |
| 06 | Harnesses | `/harnesses` | — | modal today |
| 07 | Channels (Feishu) | `/channels` (reserve `/channels/feishu`) | — | modal today |
| 08 | Doctor / system | `/doctor` | — | modal today |
| 09 | Settings | `/settings` | `?tab=appearance\|language\|devices\|prefs` | dropdown+modal today |
| 10 | Notifications | `/notifications` | — | **net-new [N]** |
| 11 | File / artifact viewer | `/mesh/<id>/agent/<agentId>/file/<path>` · `…/artifact/<path>` | `?lb=1` (lightbox) | **already routed** ✔ |
| 12 | Device-auth gate | route-agnostic pre-gate; unauthorized renders the gate over any path | `?next=<path>` (return-to after approval) | Boot, no URL today |
| 13 | Global states (offline / error / 404) | cross-cutting; unknown SPA path → in-app `NotFound`; offline/error are overlays on the current route | — | none today |

Notes / decisions folded in:
- **Mesh-scoped vs global:** runtime/board/new-edit/file-viewer are **mesh-scoped**
  (`/mesh/<id>/…`); assistant/harnesses/channels/doctor/settings/notifications are
  **global** (top-level). This matches today's ownership (Sidebar owns mesh list +
  assistant; the modals are global).
- **`/mesh/new` vs `/mesh/<id>`:** `new` is a reserved mesh id — the router must match
  `/mesh/new` and `/mesh/<id>/edit` **before** treating the segment as a mesh id.
- **Canvas & fullscreen:** canvas is given a path segment (`/canvas`) because it is a
  distinct full-surface view worth deep-linking; session/assistant fullscreen and board
  kanban stay **query view-state** because they are the same resource in a different
  presentation. (Open question 4.2 — confirm canvas-as-path vs `?canvas`.)
- **Board** keeps its existing query contract; we only **re-home** its parsing under the
  central router (one `popstate` owner instead of two) and add the `/board/issue/<n>`
  path form alongside today's search form.

**Surface/route count:** 13 surfaces → **~19 distinct route patterns** (12 path patterns +
board/settings/file view-state variants).

### 1.2 Router choice — recommendation: **hand-written minimal router** (no library)

Recommended: a ~150-line in-repo router (`client/router.tsx`) exposing `useRoute()` (parse
`location.pathname+search` → a typed `Route` union) + `navigate(to, {replace})`, layered on
the **existing** RouteLink/`spaTarget` + a single `popstate` subscription.

Reasons (grounded in this codebase):
1. **The primitives already exist and are tested.** RouteLink/`spaTarget` (C5) does
   same-origin interception + native fallbacks; BoardPanel and FileViewer already
   hand-parse routes. A library would *replace* working, audited code, not save us writing
   it. ✔
2. **Bun build / `bun build --compile`.** The console ships as a Bun-bundled SPA (server
   imports `index.html`; `bun build --compile` is a project constraint per CLAUDE.md/Zed
   alignment work). A zero-dependency router has no resolver/ESM-interop/treeshaking risk
   under compile; React Router v6/v7's data-router + its package graph is more surface area
   to keep working across Bun upgrades for a 13-surface app.
3. **Small, known surface.** 19 route patterns, one app, one origin. A full router's
   loaders/actions/nested-layout machinery is unused weight; our "data layer" is already
   the WS **store**, not route loaders.
4. **State lives in the store, not the route.** URL ↔ store sync is a *selection* problem
   (which mesh/agent/issue is focused), which a tiny `useRoute()` + store-select solves
   directly; we don't want a second source of truth (a router cache) competing with the
   store.
5. **Tailwind / SSR-free.** No interaction with Tailwind; no SSR to reconcile (we render
   client-only). Nothing a library would simplify.

Trade-off / when to revisit: if Step 7 later wants per-route code-splitting + data
preloading + nested layouts at scale, revisit React Router. For now, hand-written wins on
risk and fit. (Open question 4.1 — final call belongs to prdmgr/user.)

Router sketch (illustrative, not committed):
```
type Route =
  | { k: "runtime"; mesh: string; agent?: string; canvas?: boolean; full?: boolean }
  | { k: "board"; mesh: string; issue?: number; view: "list"|"kanban"; filters: BoardFilters }
  | { k: "newMesh"; editOf?: string }
  | { k: "assistant"; full?: boolean }
  | { k: "harnesses" } | { k: "channels" } | { k: "doctor" }
  | { k: "settings"; tab?: SettingsTab } | { k: "notifications" }
  | { k: "file"; mesh: string; agent: string; kind: "file"|"artifact"; path: string; lb?: boolean }
  | { k: "notFound" };
useRoute(): Route            // parse on mount + on popstate (single global listener)
navigate(to: Route|string, {replace?})   // build href via the same serializers, pushState + dispatch popstate
```
Reuse `parseFileRoute`/`parseBoardRoute`/`serializeBoardRoute` verbatim inside the parser
so the two already-shipped contracts are preserved exactly.

### 1.3 Path vs hash — recommendation: **path-based** (no blocker found)

The code audit shows no blocker: the server already SPA-falls-back for `/mesh/*` and the
two existing routers use pathname/search (not hash). Path keeps URLs clean and
right-clickable. The only requirement path imposes is **server fallback for the new
top-level routes** (§1.4). Hash would avoid server changes but breaks the existing
`/mesh/<id>/agent/<id>/file/<path>` deep links and `RouteLink` semantics — rejected.

### 1.4 Server SPA fallback design (`server.ts`)

Goal: serve `index.html` for every deep UI path **without** breaking `/api/*`, `/ws`,
guarded `/__ui-preview`/`/__ui-mockup`, static assets, or device-auth.

Current fetch order is already correct (most-specific first): `/ws` → `/api/*` →
`__ui-*` guard → asset fetch. We change only the **asset fallback**:

1. **Widen the asset server route map** from `{ "/", "/mesh/*", "/__ui-preview",
   "/__ui-mockup" }` to also map the new top-level surfaces to `index.html`:
   `/assistant`, `/harnesses`, `/channels`, `/doctor`, `/settings`, `/notifications`,
   `/mesh/new`, and (covered by `/mesh/*`) all mesh-scoped sub-paths. Prefer **explicit
   prefixes** over a blanket `/*` so unknown asset requests still 404 (don't serve HTML
   for a missing `.js`).
2. **Fallback rule for unknown non-asset paths:** if the path has no file extension and is
   not `/api`/`/ws`/`__ui-*`, serve `index.html` (the SPA renders its own in-app 404 for
   genuinely unknown routes, surface 13). Paths *with* an extension (assets) keep returning
   the asset/404 from the bundle so a real missing asset is a real 404.
3. **Cache-control:** extend the `no-store` SPA header (currently `/` and `/mesh/*`) to all
   HTML-serving routes so a deployed frontend upgrade is picked up (works with the existing
   `UpgradePrompt`/`appVersion` flow).
4. **Order/guard invariants preserved:** `/api/*` and `/ws` are matched **before** the
   asset fallback, so widening it cannot shadow them. `__ui-preview`/`__ui-mockup` stay
   behind `MESH_UI_PREVIEW=1` (404 when off) — that check stays *before* the fallback.
   Device-auth is unaffected: it is enforced on `/api/*` (server) + the Boot gate (client),
   neither of which depends on which HTML path was served. A deep link to `/doctor` while
   unauthorized still serves `index.html` → Boot shows the gate → after approval the client
   routes to `/doctor` (via `?next=`). ✔
5. **Smoke coverage:** `server.smoke.ts` must add: deep-link GET for each new top-level
   route returns `200 text/html`; `/api/*` and `/ws` still gate; a missing asset still
   `404`; `__ui-*` still `404` when `MESH_UI_PREVIEW` unset.

### 1.5 Real `<a href>` migration

Replace state-callback navigation with `RouteLink` (or `StatusListRow`'s `href`) so rows
are real links (right-click → "open in new tab", middle-click, ⌘/Ctrl-click all native):
- **Sidebar mesh rows** → `RouteLink href="/mesh/<id>"` (today `onSelect(name)` + localStorage). ✔
- **Topology/overview agent nodes** → `RouteLink href="/mesh/<id>/agent/<agentId>"`. ✔
- **Board rows** → `/mesh/<id>/board/issue/<n>` (board already pushes state; swap to RouteLink). ✔
- **Management entries** (topbar `管理▾`/`设置▾`) → links to `/harnesses`, `/channels`,
  `/doctor`, `/settings`, `/notifications`, `/assistant`, `/mesh/new`.
- **Same-origin interception** is handled by `spaTarget`; **external** links (official
  harness docs in `SelfInstallerGuide`, Feishu links) must keep `target=_blank`
  rel=noopener so they stay native. The mockups already encode this split.

---

## 2. Step 7 phased migration plan

Each phase lands as its own gated checkpoint (per-commit STOP+await, as in C1–C5). "Wired
to real data" = consumes the **store** (WS snapshot+deltas) and the REST endpoints listed.

### 7.0 — Routing + new app-shell foundation (parity + fallback FIRST)
- **Goal:** introduce `router.tsx` + the redesigned adaptive shell (topbar `管理▾`/`设置▾`,
  collapsible left nav, right context) and **mount the existing real views inside it**
  unchanged, so nothing regresses while routes/fallback come online. No business logic
  rewritten yet.
- **Data source:** existing `store` (meshes list, connection, upgrade); `localStorage`
  selection migrated to read **from the route** (`/mesh/<id>`), falling back to the stored
  value only for `/`.
- **Components reused:** `App` decomposed into shell + `<Outlet>`-style route switch;
  `Sidebar` (mesh list), `MeshDetail`, modals temporarily reachable as routed wrappers.
  `RouteLink` for mesh rows.
- **Server:** the §1.4 fallback widening + smoke coverage land here.
- **Capabilities preserved:** mesh list pagination (#19), reload-defs (#20), connection/
  upgrade banners, device-auth gate, file-viewer route (must keep working byte-for-byte).
- **Tests/e2e/a11y:** router unit tests (parse/serialize round-trip incl. board+file
  contracts); `server.smoke` deep-link matrix; an e2e that deep-links each top-level route
  and asserts the right surface mounts + reload (popstate) keeps it; a11y unchanged.

### 7.1 — Runtime A (the daily driver)
- **Routes:** `/mesh/<id>`, `/mesh/<id>/agent/<agentId>` (`?full=1`), `/mesh/<id>/canvas`.
- **Data source:** `store` per-mesh state — `transcripts` (paginated via
  `/api/meshes/{}/agents/{}/transcript`, `loadInitialTranscript`/`loadOlderTranscript`),
  `activity`, `mail`, `pending`/`history` (permissions), `queues`, `modes/models/efforts/
  usage/health`. Mutations: `promptAgent`/`steerAgent`/`interruptAgent`/`wakeAgent`/
  `stopAgent`/`newAgentSession`/`newAllSessions`/`respawnAgent`/`resolvePermission`/
  `setMode`/`setModel`/`setEffort`/`addAgent`/`addEdge`/`startMesh`(strategy)/`stopMesh`.
- **Components reused:** `MeshDetail`, `ChatPane`, `Transcript`/`VirtualTranscript`,
  `Topology`, `MeshCanvas`, `health.tsx` (ContextUsageChip/health badges) — restyled to v2
  tokens + the C2 docked approval bar + C5 canvas edges/force-layout.
- **Capabilities preserved (audit):** #9 session fullscreen, #10 per-agent mode/model/
  effort/kimi, #11 wake, #12 context/health/silent-stop, #13 pending-turns queue, #14
  transcript expand toggles, #15 jump-to-bottom/load-older, #16 zoomable canvas, #17 live
  add agent/edge, #18 start-strategy/new-all-sessions.
- **C-revision constraints:** C2 docked composer-adjacent approval bar (FIFO + queue badge,
  sticky/scroll, mobile-above-keyboard); C5 directed mail edges + recent-traffic pulse +
  force-directed default-on + pinned dragged node — must be the **real** canvas behavior
  (real `position: sticky`, real edges from config, real drag→pin).
- **Tests/e2e/a11y:** deep-link to overview/focus/canvas; approval-resolve flow; queue
  nav/remove; load-older; canvas drag→pin; a11y over the live runtime in all themes.

### 7.2 — Board C
- **Routes:** `/mesh/<id>/board` (`?view&status&label&assignee&epic&q&sort&group`),
  `/mesh/<id>/board/issue/<n>`.
- **Data source:** `store.board` per mesh — `ensureBoardLoaded`/`getBoard`
  (`GET /api/meshes/{}/board`, one-shot+coalesced), live `board` WS snapshots, mutations
  via `boardCommand` (`POST …/board` with CAS `expectedBoardRevision`; 409 → silent
  refetch). Reuse `parseBoardRoute`/`serializeBoardRoute` under the central router.
- **Components reused:** `BoardPanel` (List/Kanban/Detail) restyled to the **C4 GH-Issues
  filter** (persistent search + 筛选▾ dropdown + removable chips + right action group +
  boundary collapse + nav/context collapse for width).
- **Capabilities preserved (audit):** #22 board fullscreen, #23 group-by-epic, #24
  manage-labels CRUD + palette, #25 create-epic + reopen terminal; plus lifecycle
  auto-reflow + router dispatch.
- **Tests/e2e/a11y:** filter→URL round-trip; CAS-409 reconcile; label CRUD; reopen; kanban
  drag = set_status (perm-gated); a11y on label chips (already audited) in the live board.

### 7.3 — New-mesh + Assistant B
- **Routes:** `/mesh/new`, `/mesh/<id>/edit` (`?nmEditor=…`); `/assistant` (`?full=1`).
- **Data source:** `defineMesh` (`POST /api/meshes`, raw validation surfaced), `openEditor`
  (`GET /api/meshes/{}/config`), `listHarnesses`/harness models for selects; assistant
  `promptAssistant`/`interruptAssistant` + `state.assistant` transcript/capabilities.
- **Components reused:** `MeshBuilder` (becomes a routed page, not a modal), incl.
  `TextEditorDialog` expanded editor; `Sidebar`'s `AssistantChat` extracted to a routed
  `/assistant` page.
- **Capabilities preserved (audit):** #1 per-agent instructions, #2 expanded text-editor
  modal, #3 model+probe/retry, #4 effort, #5 lazy, #6 opencode permission, #7 auto-compact,
  #8 edge steer; #21 assistant fullscreen.
- **C-revision constraints:** C3 long-form scrolling — sticky action bar (desktop) / fixed
  Save footer (mobile) / add-agent auto-scroll+focus / no nested overflow trap — as **real**
  sticky/scroll behavior with N agents.
- **Tests/e2e/a11y:** create+edit round-trip incl. validation; expanded editor focus-trap;
  long-form sticky/fixed-save with many agents; assistant chat + fullscreen; a11y.

### 7.4 — Harnesses / Channels / Doctor / Settings / Notifications / File-viewer / Device-auth
- **Routes:** `/harnesses`, `/channels`, `/doctor`, `/settings` (`?tab`), `/notifications`,
  the existing file-viewer routes, device-auth gate (`?next`).
- **Data source:** harnesses — `listHarnesses`/`installHarness`/`streamHarnessInstall`/
  `reprobeHarness`; channels — `getFeishuStatus`/`startFeishuProvision`/`getFeishuProvision`/
  `cancelFeishuProvision`/`syncFeishuMeshChats`/`ensureFeishuMeshChat`; doctor — `fetchDoctor`
  (`/api/diagnostics/doctor`) + `fetchPsDetail` (`/api/diagnostics/ps`); settings —
  `Theme`/`themes.ts` + `i18n` + device-management endpoints; file-viewer — `AuthedImage`/
  `FileViewer` (already routed); device-auth — `Boot`/`device-auth.ts`.
- **Net-new pages:** **Notifications (#10 [N])** has *no* server or client system today
  (only transient client toasts). Step 7.4 either (a) builds the server-persistent
  notification store the redesign §1.4 specifies, or (b) ships the page against toasts +
  derived signals as an interim. **Decision needed (open question 4.x).** Settings
  default-view/default-device prefs are also [N].
- **Capabilities preserved (audit):** #26 install progress live log + retry-stream + close,
  #27 self-install guide (copy cmd + docs link + reprobe), #28 restart old-version agents
  (force/after-idle/cancel). Device-auth invariants: approved-token-only allow path,
  loopback not trusted, host CLI approve authoritative, bootstrap token body-only/never
  persisted, generic non-leaky errors for revoked/unknown/expired.
- **Tests/e2e/a11y:** harness install stream + retry; Feishu provision polling; doctor
  reap/restart (orphan reap + daemon restart only); settings theme×accent + lang + device
  approve/revoke; device-auth gate happy/again; a11y across all themes.

### 7.5 — Mobile + global states + regression hardening
- **Routes:** all of the above on mobile; global 404/offline/error.
- **Data source:** same stores; offline = WS reconnect state (`useConnected`, store
  reconnect toasts); errors = per-surface ErrorBanner + retry.
- **Components reused:** mobile shell (bottom tabs 运行态/看板/更多), all surfaces' mobile
  treatments.
- **Capabilities preserved:** mobile parity per the coverage matrix (full/simplified/
  deferred-by-design); the **C1 mobile anti-pattern rules** (stack rows; `whitespace-nowrap`
  buttons to a new row; split section headers) as real responsive behavior.
- **Tests/e2e/a11y:** mobile deep-links + bottom-tab nav; offline/reconnect; in-app 404;
  full regression of the audit checklist (§3); a11y mobile viewport in all themes.

---

## 3. Capability parity checklist (the 28-item hard gate)

Source of truth: `coverage/14-existing-capability-audit.md` (28 [E] items). Each must be
**verified working in the real page** in its phase below (not just in the mockup).

| # | Capability | Verify in phase |
|---|------------|-----------------|
| 1 | Per-agent instructions (≤4000) | 7.3 |
| 2 | Expanded text-editor modal (charter+instructions) | 7.3 |
| 3 | Per-agent model + probe/retry | 7.3 |
| 4 | Per-agent reasoning effort | 7.3 |
| 5 | Per-agent lazy | 7.3 |
| 6 | opencode permission (ask/allow) | 7.3 |
| 7 | Auto-compact enable + threshold | 7.3 |
| 8 | Mail-edge steer | 7.3 |
| 9 | Session fullscreen | 7.1 |
| 10 | Per-agent runtime selectors (mode/model/effort/kimi) | 7.1 |
| 11 | Wake lazy/cold agent | 7.1 |
| 12 | Context usage chip + near-limit + silent-stop badge | 7.1 |
| 13 | Pending-turns queue (prev/next + remove) | 7.1 |
| 14 | Transcript item expand toggles (thought/tool/mail) | 7.1 |
| 15 | Jump-to-bottom + load-older | 7.1 |
| 16 | Zoomable topology canvas | 7.1 (C5 behavior) |
| 17 | Live add agent / add edge | 7.1 |
| 18 | Start-strategy + new-all-sessions | 7.1 |
| 19 | Mesh-list pagination | 7.0 |
| 20 | Reload mesh definitions (2-click) | 7.0 |
| 21 | Assistant chat fullscreen | 7.3 |
| 22 | Board fullscreen | 7.2 |
| 23 | Group-by-epic | 7.2 |
| 24 | Manage-labels CRUD + palette | 7.2 |
| 25 | Create-epic + reopen terminal | 7.2 |
| 26 | Install progress live log + retry-stream + close | 7.4 |
| 27 | Self-install guide (copy/docs/reprobe) | 7.4 |
| 28 | Restart old-version agents (force/after-idle/cancel) | 7.4 |

**C1–C5 review revisions as implementation constraints** (must hold in the real pages):
- **C1** (7.5, and every surface as built): mobile anti-pattern rules — stack rows,
  `whitespace-nowrap` buttons wrap to a new row, split section headers.
- **C2** (7.1): docked composer-adjacent approval bar — FIFO oldest + `还有 N`, queue
  badge, never scrolls away, long content capped, mobile above keyboard.
- **C3** (7.3): new-mesh long-form — sticky action bar (desktop) / fixed Save (mobile) /
  add-agent auto-scroll+focus / no nested overflow trap.
- **C4** (7.2): board GH-Issues filter — persistent search + 筛选▾ + removable chips +
  right action group + boundary collapse + nav/context collapse for width.
- **C5** (7.1): canvas — directed mail edges + recent-traffic highlight/pulse +
  force-directed default-on + pinned dragged node; keep stop/wake/⋯/zoom/Esc.

Gate rule: a phase is not "done" until its mapped audit rows + C-constraints are
demonstrated in the real, store-wired page (tests/e2e/a11y), not the mockup.

---

## 4. Risks / open questions

**4.1 Router: library vs hand-written (DECISION NEEDED).** Recommendation = hand-written
minimal router (§1.2). Needs prdmgr/user sign-off before 7.0, since it's load-bearing for
every later phase. If they prefer a library, React Router v7 is the fallback; cost is
bundle/compile risk + reconciling its history with `RouteLink`/`spaTarget`.

**4.2 URL naming details (MAY NEED APPROVAL).** Confirm: canvas as path `/mesh/<id>/canvas`
vs query `?canvas`; fullscreen as `?full=1`; board `/board/issue/<n>` vs keeping
search-only; `/channels` vs `/channels/feishu` top-level; settings `?tab=` names;
device-auth `?next=` for return-to.

**4.3 Cutover strategy.** Recommendation = **route-gated coexistence**, not a big-bang
switch. Build the new shell behind the router from 7.0 with existing views mounted inside;
migrate one surface per phase; keep the old modal entry points working until each surface's
routed page lands; flip the default landing last. (Alternative: a `MESH_UI_NEXT=1`-gated new
shell that runs beside the current one until parity — heavier, only if the user wants a
hard A/B.) **Decision needed: coexistence vs gated-flag vs one-time switch.**

**4.4 Highest implementation risks.**
- **Server fallback + auth:** widening the SPA fallback must not accidentally serve HTML for
  `/api`/`/ws`/missing assets, and must keep device-auth + `__ui-*` gating intact (§1.4).
  Mitigation: explicit prefixes + extension check + smoke matrix.
- **URL ↔ store sync:** the route is the *selection*; the store is the *data*. Risk of two
  sources of truth (route vs `localStorage["mesh.selected"]` vs `selectedAgent` state).
  Mitigation: route is authoritative for selection; localStorage becomes only the `/`
  default hint; `selectedAgent`/`fullView`/modal booleans are derived from the route.
- **Preserving capability-rich surfaces:** device-auth (fail-closed invariants),
  Feishu/channels, doctor (reap/restart-only scope), board (CAS), p2p/approval, mobile
  parity — each is a regression magnet; the §3 checklist + per-phase e2e are the guard.
- **Notifications [N]:** net-new server-persistent system is the largest unknown (no code
  today); may warrant its own design sub-task before 7.4 (open question 4.x).
- **Board double-routing:** BoardPanel currently owns its own `popstate`; folding it under
  one router without breaking back-button semantics needs care (reuse its serializers,
  single listener).

---

## 5. Sources read (grounding)

Real code (read, not mockup): `src/web/server.ts`, `src/web/client/index.tsx`,
`src/web/client/App.tsx`, `src/web/client/Boot.tsx`, `src/web/client/device-auth.ts`,
`src/web/client/store.ts`, `src/web/client/ui/RouteLink.tsx`, `src/web/client/FileViewer.tsx`
(`parseFileRoute`), `src/web/client/BoardPanel.tsx` (`parseBoardRoute`/`serializeBoardRoute`/
popstate), and (via read-only inventory) `MeshDetail.tsx`, `Sidebar.tsx`, `MeshBuilder.tsx`,
`HarnessPanel.tsx`, `SystemPanel.tsx`, `FeishuPanel.tsx`, `Theme.tsx`, `ChatPane.tsx`,
`Transcript.tsx`/`VirtualTranscript.tsx`, `MeshCanvas.tsx`, `Topology.tsx`, `health.tsx`,
`src/web/types.ts` (Gateway/PerMesh state). Verified by grep/Read: BoardPanel route fns +
popstate; FileViewer regex `^/mesh/([^/]+)/agent/([^/]+)/(file|artifact)/(.+)$`; token key
`mesh.deviceToken` (Bearer on `/api/*`, `?token=` on `/ws` only); server asset route map
`{ "/", "/mesh/*", "/__ui-preview", "/__ui-mockup" }` + fetch order.

Docs read: `coverage/00-index.md` (route/IA inventory, state vocabulary, the C1/C2 central
notes), `coverage/01`–`13` (per-surface routes + exists/net-new marks), `coverage/14-existing-
capability-audit.md` (the 28-item [E] checklist + resolved ownership), and the Step 6 mockup
change-logs in `coverage/02`–`04` (C2/C3/C4/C5 constraints).

---

## Change log
- 2026-06-21 — created (Step 7 planning checkpoint, docs-only): URL scheme for all 13
  surfaces, router recommendation (hand-written), path-vs-hash (path), server SPA fallback
  design, RouteLink migration, phased 7.0–7.5 plan, 28-item parity mapping + C1–C5
  constraints, risks/open questions. Grounded in the real client/server code (see §5).
