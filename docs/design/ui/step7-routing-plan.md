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
pathname), (c) a server that already SPA-falls-back for `/` and `/mesh/*`. Step 7.0 builds
a new router + new shell **under `/bnw/`**, reusing the *logic* of those parsers (forked,
not mutated) and adding a single `/bnw/*` server fallback — the old root UI is left
completely untouched.

> **LOCKED ARCHITECTURE (prdmgr/user, this rewrite).** Cutover = **parallel `/bnw/`
> namespace**, not the earlier route-gated/new-shell-on-root strategy.
> 1. **Router** = hand-written minimal router (§1.2).
> 2. **All new UI paths under `/bnw/`** (§1.1).
> 3. **`index.tsx` split:** a `/bnw/` pathname prefix mounts the new router/new shell;
>    everything else (incl. old `/`, old `/mesh/*`, `/__ui-*`) continues to the existing
>    `<Boot>/<App>` **unchanged**. The device-auth Boot gate wraps **both** old and new UI.
> 4. **Independent view layer:** the new `/bnw/` UI must **NOT mutate the shared old view
>    components in place** (`MeshDetail`, `BoardPanel`, `ChatPane`, `Topology`,
>    `MeshCanvas`, `Sidebar`, `MeshBuilder`, `HarnessPanel`, `SystemPanel`, `FeishuPanel`,
>    `Theme`, …). The **data layer is shared** (store / API / WS / `device-auth.ts` /
>    serializer logic), but the **view layer is new/forked/independent**, built from the
>    C5–C8 component library + the approved mockup structure. Old UI stays as a safety net.
> 5. **Notifications [N] = Option B** (real server-persisted system, part of Step 7 — §2
>    7.4 mini-design), not an interim toast shim.
> 6. **28-item parity is a hard gate for the new `/bnw/` UI.** The old UI being available
>    is a safety net, NOT permission to omit any parity item.

---

## 1. URL routing foundation design

### 1.1 URL scheme (all 13 surfaces)

Principle: **resource identity in the path** (deep-linkable, shareable, new-tab-able);
**ephemeral view-state in the query** (filters, kanban/list, fullscreen, canvas). Path
segments mirror the IA priority **A 运行态 > C 看板 > B 管理**.

**LOCKED (prdmgr/user):** every new UI path is under the **`/bnw/` namespace**. The old
root UI (`/`, old `/mesh/*`, …) is untouched and keeps working; the new console is an
independent parallel tree mounted only under `/bnw/`. The route *shapes* are exactly the
originally-recommended scheme, just `/bnw`-prefixed; nothing is served at these paths yet.

| # | Surface | Canonical route | View-state (query) | Notes |
|---|---------|-----------------|--------------------|-------|
| 01 | App shell / landing | `/bnw/` → redirect to default mesh runtime (`/bnw/mesh/<default>`) | — | new shell |
| 02 | Runtime A — overview | `/bnw/mesh/<id>` | — | new view (data via store) |
| 02 | Runtime A — focus (agent) | `/bnw/mesh/<id>/agent/<agentId>` | `?full=1` (session fullscreen, #9) | new |
| 02 | Runtime A — canvas | `/bnw/mesh/<id>/canvas` | — | new (#16; was `topoOpen` state) |
| 03 | Board C — list | `/bnw/mesh/<id>/board` | `?view=list\|kanban&status=&label=&assignee=&epic=&q=&sort=&group=epic` | new view; reuse board serializers |
| 03 | Board C — detail | `/bnw/mesh/<id>/board/issue/<n>` | (filters preserved in query) | new |
| 04 | New-mesh builder | `/bnw/mesh/new` (create) · `/bnw/mesh/<id>/edit` (edit) | `?nmEditor=charter\|instructions` (#2) | was modal |
| 05 | Mesh Assistant B | `/bnw/assistant` | `?full=1` (chat fullscreen, #21) | was inside Sidebar |
| 06 | Harnesses | `/bnw/harnesses` | — | was modal |
| 07 | Channels (Feishu) | `/bnw/channels` (reserve `/bnw/channels/feishu`) | — | was modal |
| 08 | Doctor / system | `/bnw/doctor` | — | was modal |
| 09 | Settings | `/bnw/settings` | `?tab=appearance\|language\|devices\|prefs` | was dropdown+modal |
| 10 | Notifications | `/bnw/notifications` | — | **net-new [N], Option B (server-persisted, §2 7.4)** |
| 11 | File / artifact viewer | `/bnw/mesh/<id>/agent/<agentId>/file/<path>` · `…/artifact/<path>` | `?lb=1` (lightbox) | reuse `parseFileRoute` logic, `/bnw`-prefixed |
| 12 | Device-auth gate | route-agnostic pre-gate; unauthorized renders the gate over any path (old or `/bnw/`) | `?next=<path>` (a `/bnw/…` return-to) | Boot wraps both UIs |
| 13 | Global states (offline / error / 404) | cross-cutting; unknown `/bnw/*` path → in-app `NotFound`; offline/error overlay the current route | — | new |

Notes / decisions folded in:
- **`/bnw/` prefix is mandatory** on every new route. The central router strips the
  `/bnw` prefix first, then parses the remainder with the shapes above, so all routing
  logic is identical to the original recommendation — only namespaced.
- **Mesh-scoped vs global:** runtime/board/new-edit/file-viewer are **mesh-scoped**
  (`/bnw/mesh/<id>/…`); assistant/harnesses/channels/doctor/settings/notifications are
  **global** (`/bnw/<surface>`). This matches today's ownership (Sidebar owns mesh list +
  assistant; the modals are global).
- **`/bnw/mesh/new` vs `/bnw/mesh/<id>`:** `new` is a reserved mesh id — the router must
  match `/bnw/mesh/new` and `/bnw/mesh/<id>/edit` **before** treating the segment as a
  mesh id.
- **Canvas & fullscreen:** canvas is given a path segment (`/canvas`) because it is a
  distinct full-surface view worth deep-linking; session/assistant fullscreen and board
  kanban stay **query view-state** because they are the same resource in a different
  presentation. (Open question 4.2 — confirm canvas-as-path vs `?canvas`.)
- **Board** keeps its existing query contract; the new `/bnw/` board view **reuses the
  `parseBoardRoute`/`serializeBoardRoute` serializers** (forked into the new view per the
  §4 independent-view-layer constraint) under the one central `popstate` owner, and adds
  the `/board/issue/<n>` path form alongside the search form.

**Surface/route count:** 13 surfaces → **~19 distinct route patterns** (12 path patterns +
board/settings/file view-state variants), **all under `/bnw/`**.

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
useRoute(): Route            // strip the `/bnw` prefix, then parse pathname+search; re-parse on popstate (single global listener)
navigate(to: Route|string, {replace?})   // build a `/bnw`-prefixed href via the serializers, pushState + dispatch popstate
```
The router operates only inside `/bnw/`: it strips the `/bnw` prefix before parsing and
re-adds it when serializing. Reuse the **logic** of `parseFileRoute`/`parseBoardRoute`/
`serializeBoardRoute` (forked into the new view layer per §4, not imported from the old
components) so the two already-shipped route contracts are preserved exactly under `/bnw/`.

### 1.3 Path vs hash — recommendation: **path-based** (no blocker found)

The code audit shows no blocker: the server already SPA-falls-back for `/mesh/*` and the
two existing routers use pathname/search (not hash). Path keeps URLs clean and
right-clickable. The only requirement path imposes is the **`/bnw/*` server fallback**
(§1.4). Hash would avoid server changes but breaks deep links and `RouteLink` semantics —
rejected.

### 1.4 Server SPA fallback design (`server.ts`) — `/bnw/*` ONLY

**LOCKED:** the server fallback widens **only the `/bnw/*` namespace** to `index.html`.
Root and old routes (`/`, old `/mesh/*`, etc.), `/api/*`, `/ws`, and the `__ui-*` guards
are **unchanged**. Goal: serve `index.html` for every deep `/bnw/` path without touching
the old UI or breaking API/WS/guards/static assets/device-auth.

Current fetch order is already correct (most-specific first): `/ws` → `/api/*` →
`__ui-*` guard → asset fetch. We change only the asset fallback, scoped to `/bnw/`:

1. **Add one `/bnw/*` route** to the asset server map → `index.html`. The existing
   `{ "/", "/mesh/*", "/__ui-preview", "/__ui-mockup" }` entries stay exactly as they are
   (old root UI untouched). The single new namespaced route covers every `/bnw/` surface
   and sub-path (`/bnw/`, `/bnw/mesh/<id>/…`, `/bnw/assistant`, `/bnw/harnesses`, …).
2. **Fallback rule, `/bnw/`-scoped:** for a `/bnw/…` path with no file extension, serve
   `index.html` (the new SPA renders its own in-app 404 for unknown `/bnw/` routes, surface
   13). A `/bnw/…` path *with* an extension (a bundled asset) keeps returning the
   asset/404 so a real missing asset is a real 404. Non-`/bnw/` unknown paths keep today's
   behavior — **no change** to the old fallback.
3. **Cache-control:** apply the same `no-store` SPA header already used for `/` and
   `/mesh/*` to `/bnw/*` HTML responses (so a deployed frontend upgrade is picked up via
   the existing `UpgradePrompt`/`appVersion` flow). Existing headers unchanged.
4. **Order/guard invariants preserved:** `/api/*` and `/ws` are matched **before** the
   asset fallback, so the `/bnw/*` route cannot shadow them. `__ui-preview`/`__ui-mockup`
   stay behind `MESH_UI_PREVIEW=1` (404 when off) — that check stays *before* the fallback.
   Device-auth is unaffected: enforced on `/api/*` (server) + the Boot gate (client),
   neither of which depends on which HTML path was served. A deep link to `/bnw/doctor`
   while unauthorized still serves `index.html` → Boot shows the gate → after approval the
   client routes to `/bnw/doctor` (via `?next=`). ✔
5. **Smoke coverage:** `server.smoke.ts` adds: deep-link GET for representative `/bnw/`
   routes returns `200 text/html`; the **old** root/`/mesh/*` routes still serve as before;
   `/api/*` and `/ws` still gate; a missing `/bnw/` asset still `404`; `__ui-*` still `404`
   when `MESH_UI_PREVIEW` unset.

### 1.5 Real `<a href>` migration

In the **new `/bnw/` views**, navigation uses `RouteLink` (or `StatusListRow`'s `href`) so
rows are real links (right-click → "open in new tab", middle-click, ⌘/Ctrl-click native).
These are built in the new view layer (§4) — the **old** components keep their existing
state-callback navigation untouched. New `/bnw/` link targets:
- **Sidebar/new-shell mesh rows** → `RouteLink href="/bnw/mesh/<id>"`.
- **Topology/overview agent nodes** → `RouteLink href="/bnw/mesh/<id>/agent/<agentId>"`.
- **Board rows** → `RouteLink href="/bnw/mesh/<id>/board/issue/<n>"`.
- **Management entries** (topbar `管理▾`/`设置▾`) → `/bnw/harnesses`, `/bnw/channels`,
  `/bnw/doctor`, `/bnw/settings`, `/bnw/notifications`, `/bnw/assistant`, `/bnw/mesh/new`.
- **Same-origin interception** is handled by `spaTarget`; **external** links (official
  harness docs in `SelfInstallerGuide`, Feishu links) keep `target=_blank` rel=noopener so
  they stay native. The mockups already encode this split.

---

## 2. Step 7 phased migration plan

Each phase lands as its own gated checkpoint (per-commit STOP+await, as in C1–C5). "Wired
to real data" = consumes the **store** (WS snapshot+deltas) and the REST endpoints listed.

> **Reading "Components" under the LOCKED independent-view-layer constraint (§0.4):** every
> phase builds **new `/bnw/` view components** from the C5–C8 component library + the
> approved mockup structure. Where a phase lists an old component (e.g. `MeshDetail`,
> `BoardPanel`), it is the **behavioral/structural reference** for the new forked view and
> the **shared data layer** it reads (store/API/WS) — the old file itself is **not mutated**
> and keeps serving the old root UI. Only non-view logic (route serializers, `device-auth.ts`,
> `themes.ts`, `i18n.ts`, store hooks) is imported directly.

### 7.0 — `/bnw/` routing foundation + new shell skeleton (FIRST; old UI untouched)
- **Goal:** stand up the parallel `/bnw/` tree: (a) `index.tsx` split — `/bnw/` prefix
  mounts the new router + new shell; all else → existing `<Boot>/<App>` unchanged; (b)
  `router.tsx` hand-written minimal router (strip `/bnw`, parse, `navigate`); (c) the new
  redesigned adaptive **shell skeleton** (topbar `管理▾`/`设置▾`, collapsible left nav,
  right context) with route-switched **placeholders** for the 13 surfaces; (d) the
  `/bnw/*` server fallback + smoke. No real surface wiring yet beyond the mesh list needed
  to navigate. Old root UI is byte-for-byte untouched.
- **Data source:** shared `store` (meshes list, connection, upgrade) for the shell;
  selection comes **from the `/bnw/` route** (not `localStorage`).
- **Components (new `/bnw/`):** new `BnwShell` + `router.tsx` + a route switch; `RouteLink`
  for mesh rows; surface placeholders. No old component is modified or mounted.
- **Server:** the §1.4 `/bnw/*` fallback + smoke coverage land here (old routes unchanged).
- **Capabilities preserved:** device-auth Boot gate wraps `/bnw/`; old UI fully intact as
  the safety net; (mesh pagination #19 / reload-defs #20 are re-implemented in the new shell
  as their surfaces land, 7.0–7.1).
- **Tests/e2e/a11y:** router unit tests (strip-prefix + parse/serialize round-trip incl. the
  forked board+file contracts); `server.smoke` `/bnw/*` matrix + old-routes-unchanged
  assertions; an e2e that deep-links representative `/bnw/` routes and asserts the right
  placeholder mounts + reload (popstate) survives; a11y on the new shell skeleton.

### 7.1 — Runtime A (the daily driver)
- **Routes:** `/bnw/mesh/<id>`, `/bnw/mesh/<id>/agent/<agentId>` (`?full=1`), `/bnw/mesh/<id>/canvas`.
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
- **Routes:** `/bnw/mesh/<id>/board` (`?view&status&label&assignee&epic&q&sort&group`),
  `/bnw/mesh/<id>/board/issue/<n>`.
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
- **Routes:** `/bnw/mesh/new`, `/bnw/mesh/<id>/edit` (`?nmEditor=…`); `/bnw/assistant` (`?full=1`).
- **Data source:** `defineMesh` (`POST /api/meshes`, raw validation surfaced), `openEditor`
  (`GET /api/meshes/{}/config`), `listHarnesses`/harness models for selects; assistant
  `promptAssistant`/`interruptAssistant` + `state.assistant` transcript/capabilities.
- **Components (new `/bnw/`):** a new routed new-mesh page (referencing `MeshBuilder`'s
  structure incl. the `TextEditorDialog` expanded editor) and a new routed `/bnw/assistant`
  page (referencing `Sidebar`'s `AssistantChat`) — built from the component library, reading
  the shared store; the old `MeshBuilder`/`Sidebar` files are not mutated.
- **Capabilities preserved (audit):** #1 per-agent instructions, #2 expanded text-editor
  modal, #3 model+probe/retry, #4 effort, #5 lazy, #6 opencode permission, #7 auto-compact,
  #8 edge steer; #21 assistant fullscreen.
- **C-revision constraints:** C3 long-form scrolling — sticky action bar (desktop) / fixed
  Save footer (mobile) / add-agent auto-scroll+focus / no nested overflow trap — as **real**
  sticky/scroll behavior with N agents.
- **Tests/e2e/a11y:** create+edit round-trip incl. validation; expanded editor focus-trap;
  long-form sticky/fixed-save with many agents; assistant chat + fullscreen; a11y.

### 7.4 — Harnesses / Channels / Doctor / Settings / Notifications / File-viewer / Device-auth
- **Routes:** `/bnw/harnesses`, `/bnw/channels`, `/bnw/doctor`, `/bnw/settings` (`?tab`),
  `/bnw/notifications`, the `/bnw/`-prefixed file-viewer routes, device-auth gate (`?next`).
- **Data source:** harnesses — `listHarnesses`/`installHarness`/`streamHarnessInstall`/
  `reprobeHarness`; channels — `getFeishuStatus`/`startFeishuProvision`/`getFeishuProvision`/
  `cancelFeishuProvision`/`syncFeishuMeshChats`/`ensureFeishuMeshChat`; doctor — `fetchDoctor`
  (`/api/diagnostics/doctor`) + `fetchPsDetail` (`/api/diagnostics/ps`); settings —
  `Theme`/`themes.ts` + `i18n` + device-management endpoints; file-viewer — `AuthedImage`/
  `FileViewer` logic (forked, `/bnw`-prefixed); device-auth — `Boot`/`device-auth.ts`.
- **Notifications (#10 [N]) = Option B (LOCKED): real server-persisted system, part of Step
  7** — built as a **7.4 prerequisite** before the client page. Mini-design:
  - **Data model:** `Notification { id, ts, kind (info|warning|error|approval|lifecycle),
    title, body?, mesh?, agent?, link? (a `/bnw/…` deep link), read: bool, dedupeKey? }`.
  - **Storage:** server-side durable, per the existing root-scoped JSON-doc + CAS pattern
    (same family as `boards/<mesh>.json` / auth-store) — e.g. `notifications.json` (or
    per-scope) with atomic write + revision; bounded ring (see retention).
  - **API:** `GET /api/notifications` (list, `?unread=1`, paginate), `POST
    /api/notifications/{id}/read`, `POST /api/notifications/read-all`, optional `DELETE`
    for dismiss. Pre-auth? No — gated like all `/api/*` (Bearer).
  - **WS event:** a new `notification` server message (snapshot on connect + deltas:
    add/read), folded into the store exactly like `board`/`activity` so the page and a
    topbar 🔔 unread badge update live.
  - **Producers:** server emits on key events (approval requested, lifecycle transitions,
    mesh/agent errors, harness install done/failed, device-auth approve/revoke) — the same
    signals that drive today's transient toasts, now persisted.
  - **Retention/cleanup:** cap N per scope (e.g. 500, mirroring permission history) +
    age-based prune on write; read items prunable first. No unbounded growth.
  - **Client page:** `/bnw/notifications` lists from the store, mark-read/read-all, filter
    unread, deep-link to source; topbar 🔔 shows unread count. Toasts remain for ephemeral
    in-session feedback; the center is the durable record.
  - Settings default-view/default-device prefs ([N]) ride the same settings surface.
- **Capabilities preserved (audit):** #26 install progress live log + retry-stream + close,
  #27 self-install guide (copy cmd + docs link + reprobe), #28 restart old-version agents
  (force/after-idle/cancel). Device-auth invariants: approved-token-only allow path,
  loopback not trusted, host CLI approve authoritative, bootstrap token body-only/never
  persisted, generic non-leaky errors for revoked/unknown/expired.
- **Tests/e2e/a11y:** harness install stream + retry; Feishu provision polling; doctor
  reap/restart (orphan reap + daemon restart only); settings theme×accent + lang + device
  approve/revoke; device-auth gate happy/again; a11y across all themes.

### 7.5 — Mobile + global states + regression hardening
- **Routes:** all of the above `/bnw/` routes on mobile; global `/bnw/` 404/offline/error.
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
demonstrated in the real, store-wired `/bnw/` page (tests/e2e/a11y), not the mockup.
**The old root UI staying available is a safety net, NOT permission to omit any parity
item** — every one of the 28 must exist and be verified in the new `/bnw/` UI.

---

## 4. Risks / open questions

**4.1 Router: library vs hand-written — RESOLVED.** Hand-written minimal router (§1.2),
locked by prdmgr/user. (Kept here for traceability; no longer open.)

**4.2 URL naming details (MAY NEED APPROVAL).** The `/bnw/` prefix + the full path list are
**locked**. Still confirm the *view-state* details: canvas as path `/bnw/mesh/<id>/canvas`
vs query `?canvas`; fullscreen as `?full=1`; board `/board/issue/<n>` vs search-only;
`/bnw/channels` vs `/bnw/channels/feishu`; settings `?tab=` names; device-auth `?next=`.

**4.3 Cutover strategy — RESOLVED: parallel `/bnw/` namespace.** Locked by prdmgr/user.
The old root UI (`/`, old `/mesh/*`, …) is **untouched**; the new console lives only under
`/bnw/` (separate `index.tsx` branch, new shell, new forked views, `/bnw/*`-only server
fallback). Per-surface migration happens **inside** `/bnw/` (7.0→7.5); the old UI remains a
full-feature safety net for the whole of Step 7 and is retired only after the new `/bnw/`
UI reaches 28-item parity and the user signs off on a final flip. Supersedes the earlier
route-gated/new-shell-on-root recommendation. **Independent view layer** (§0.4): the new UI
must not modify the old view components in place — shared data layer, forked views.

**4.4 Highest implementation risks.**
- **`/bnw/*` server fallback + auth:** the new fallback is **scoped to `/bnw/`** and must
  not serve HTML for `/api`/`/ws`/missing `/bnw/` assets, must leave the old root/`/mesh/*`
  routes byte-for-byte, and must keep device-auth + `__ui-*` gating intact (§1.4).
  Mitigation: single `/bnw/*` route + extension check + smoke matrix (incl. old-routes-
  unchanged assertions).
- **Two UIs, one data layer:** old and new UI share the store/API/WS. Risk = a shared
  *non-view* change (store/serializer) regresses the old UI. Mitigation: the §0.4
  constraint forbids mutating old **view** components; any shared-logic change is covered by
  the existing old-UI tests + the new `/bnw/` tests.
- **URL ↔ store sync:** the `/bnw/` route is the *selection*; the store is the *data*. The
  new UI derives selection (`mesh`/`agent`/`issue`/fullscreen/modal) **from the route**, not
  from `localStorage["mesh.selected"]` (that stays the old UI's concern). No second source
  of truth in the new tree.
- **Preserving capability-rich surfaces:** device-auth (fail-closed invariants),
  Feishu/channels, doctor (reap/restart-only scope), board (CAS), p2p/approval, mobile
  parity — each is a regression magnet in the new UI; the §3 checklist + per-phase e2e guard.
- **Notifications [N] = Option B:** real server-persisted system (no code today) — the
  largest net-new build; sequenced as a **7.4 prerequisite** (data model/storage/API/WS/
  retention before the client page; §2 7.4 mini-design).
- **Board route logic fork:** the new `/bnw/` board view reuses the **logic** of
  `parseBoardRoute`/`serializeBoardRoute` under the one central `popstate` owner; the old
  `BoardPanel` keeps its own routing for the old UI (two listeners across two trees is fine
  — they live on different paths). Care: don't import-and-mutate the old parser in place.

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
- 2026-06-21 — **planning rewrite (prdmgr/user locked cutover, docs-only)**: adopted the
  **parallel `/bnw/` namespace** cutover (supersedes route-gated/new-shell-on-root).
  Changed sections: **§0** (added LOCKED ARCHITECTURE box: hand-written router, `/bnw/`
  paths, `index.tsx` split, independent view layer not mutating old components, notifications
  Option B, parity-is-hard-gate); **§1.1** (every route `/bnw/`-prefixed); **§1.2** (router
  strips `/bnw`; serializer logic forked not imported); **§1.3** (`/bnw/*` fallback);
  **§1.4** (rewritten: `/bnw/*`-only server fallback, old/root/`/api`/`/ws`/`__ui-*`
  unchanged); **§1.5** (`/bnw/`-prefixed links, new view layer only); **§2** (added
  independent-view-layer note; 7.0 → `/bnw/` routing+shell skeleton+index split+`/bnw/*`
  fallback with old UI untouched; 7.1–7.5 routes `/bnw/`-prefixed; **7.4 Notifications
  rewritten to Option B with a server-persisted mini-design** — data model/storage/API/WS/
  retention as a 7.4 prerequisite); **§3** (old UI = safety net, not parity-omission);
  **§4.1/4.3 RESOLVED** (router + cutover locked), **§4.4** (risks re-scoped to `/bnw/`
  fallback, shared-data-layer, notifications Option B, board logic fork). Router decision
  (4.1) and cutover (4.3) now closed; remaining open item = view-state URL naming (4.2).
