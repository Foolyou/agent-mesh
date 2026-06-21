# 01 · App shell / global navigation — coverage

**Scope / routes.** The global chrome hosting every view: identity + connection,
mesh selection, runtime⇄board view switch, app-level entries (notifications,
management, settings), left mesh nav, mesh lifecycle controls. Frame for all routes;
`/` → runtime of the default mesh.
**Desktop/mobile.** Desktop: topbar + adaptive mesh control + left nav (collapsible,
fully hidden when collapsed) + central stage + collapsible right context. Mobile:
slim topbar + bottom tabs `运行态·看板·更多` (更多 = 管理/设置/通知); no persistent side rail.
**Exists vs net-new.** [E] chrome, mesh list/snapshot, lifecycle controls, theme/lang/
auth menus, device-auth gate; [N] the redesigned adaptive shell (label-vs-select mesh
control, fully-hidden collapsed nav), server-persisted notifications entry, default-view
preference.
**Inputs/sources read.** `../interaction/01-app-shell.md`; repo: `src/web/server.ts`
(SPA routes `/`,`/mesh/*`), `src/web/client/index.tsx` (mount/boot), `App.tsx`,
`Sidebar.tsx`/`MeshDetail.tsx` (mesh list/detail), `store.ts` (snapshot/WS),
`src/cli-dispatch.ts` (`start/stop/restart/status/ps` commands), mesh lifecycle API +
`cli-host-bearer.ts`, `themes.ts` (theme/accent), device-auth (`12`).

## Function / control / action checklist
- **Brand / identity** [E] — static; links to default landing.
- **Connection chip** [E] — connected/offline; from WS state (`store.ts`).
- **Adaptive mesh control** [N] — desktop: label when nav expanded, `mesh ▾` select when nav collapsed; mobile: always select. Switches active mesh.
- **View switcher 运行态|看板** [E] — real `<a>`: `/mesh/<m>` vs `/mesh/<m>/board` (SegmentedControl).
- **🔔 Notifications entry + unread count** [N] — opens `/notifications`; badge from server-persisted store (designed, not yet built).
- **管理▾** [E] — Assistant / Harnesses / Channels / Doctor menu.
- **设置▾** [E] — theme / language / auth / devices (folds into `/settings`).
- **Left nav (primary mesh switcher)** [E] — mesh rows (status chip + name, real `<a>`), `+ New mesh` (`/mesh/new`); collapse → fully hidden + floating expand [N].
- **Right context pane** [E] — on-demand, collapsible; content owned by active view.
- **Mesh lifecycle controls** [E] — start / stop / restart (API + `mesh start|stop|restart`), `status`/`ps` surfaced; per-mesh.
- **Mobile bottom tabs** [N-redesign] — 运行态/看板/更多; 更多 sheet = 管理/设置/通知.
- **Mesh-list pagination** [E] — ‹ › page through the mesh list (4/page; `Sidebar.tsx` `setPage`/`PER_PAGE`). (audit #19)
- **Reload mesh definitions** [E] — ↻ two-click confirm re-reads mesh defs from server (`Sidebar.tsx` `store.reload`). (audit #20)
- **Routing/deep-link** [E] — History API + SPA catch-all; every surface URL-addressable.

## Function × state matrix
✓ designed · △ partial/deferred (reason) · N/A not applicable

| Function | empty | loading | populated | error | permission | busy | offline | boundary/scale | desktop | mobile |
|---|---|---|---|---|---|---|---|---|---|---|
| Brand/identity [E] | ✓ | ✓ | ✓ | ✓ | N/A | N/A | ✓ | N/A | ✓ | ✓ |
| Connection chip [E] | ✓ | ✓(connecting) | ✓ | ✓ | N/A | N/A | ✓(offline) | N/A | ✓ | ✓(dot) |
| Adaptive mesh control [N] | ✓(no meshes→hint) | ✓(skeleton) | ✓ | ✓ | △(unauth→gate) | ✓(switching) | ✓(last-known) | ✓(many meshes→scroll) | ✓(label/select) | ✓(select) |
| View switcher [E] | ✓ | ✓ | ✓ | ✓ | N/A | ✓ | ✓ | N/A | ✓ | △(via bottom tabs) |
| Notifications entry [N] | ✓(0→no badge) | ✓ | ✓(count) | ✓ | N/A | N/A | ✓(stale count) | ✓(99+ overflow) | ✓ | ✓(in 更多) |
| 管理▾ menu [E] | ✓ | ✓ | ✓ | ✓ | △(disabled if unauth) | N/A | ✓ | N/A | ✓ | ✓(in 更多) |
| 设置▾ menu [E] | ✓ | ✓ | ✓ | ✓ | N/A | N/A | ✓ | N/A | ✓ | ✓(in 更多) |
| Left mesh nav [E] | ✓(empty hint+New) | ✓(skeleton) | ✓ | ✓ | △(unauth→gate) | ✓(row switching) | ✓(last-known) | ✓(long list→scroll; collapse) | ✓(collapsible/hidden) | △(mesh-picker sheet) |
| + New mesh [E] | ✓ | N/A | ✓ | ✓ | △(perm) | ✓ | △(disabled offline) | N/A | ✓ | ✓(in sheet) |
| Right context [E] | ✓ | ✓ | ✓ | ✓ | N/A | N/A | ✓ | ✓(long content scroll) | ✓(collapsible) | △(deferred; no rail) |
| Mesh lifecycle (start/stop/restart) [E] | ✓(stopped→Start) | ✓(starting) | ✓(running) | ✓(fail+retry) | △(perm) | ✓(in flight) | △(disabled offline) | N/A | ✓ | ✓ |
| Routing/deep-link [E] | ✓ | ✓ | ✓ | ✓(404→fallback) | ✓(unauth→gate) | N/A | ✓ | N/A | ✓ | ✓ |
| Mesh-list pagination [E] (audit #19) | N/A(no pages) | ✓ | ✓(‹ ›, 4/page) | ✓ | N/A | N/A | ✓(last-known) | ✓(many meshes→pages) | ✓ | △(within mesh-picker sheet) |
| Reload definitions [E] (audit #20) | ✓ | ✓ | ✓(↻ confirm) | ✓(fail+retry) | △(perm) | ✓(reloading) | △(disabled offline) | N/A | ✓ | ✓(in sheet) |

## Change log / sources read
- 2026-06-21 — created (Phase A commit 2). Sources: `../interaction/01-app-shell.md`;
  code paths above (`server.ts`, `index.tsx`, `Sidebar.tsx`/`MeshDetail.tsx`,
  `store.ts`, `cli-dispatch.ts`, `cli-host-bearer.ts`, `themes.ts`).
- Open: notifications [N] + default-view pref [N] carried per lead working assumptions (#680).
- 2026-06-21 — backward-consistency completion (audit `14`): +mesh-list pagination (#19),
  +reload definitions (#20). `Sidebar.tsx`.
- 2026-06-21 — Phase B Step 2 mockup补漏 (`UiMockup.tsx`): both #19/#20 rendered in the
  guarded `/__ui-mockup` app-shell. Left nav now slices the mesh list 4/page with ‹ ›
  + `{page}/{pages}` (shown only when >1 page; visible in the boundary state's many
  meshes — fixture reordered so page 0 keeps the long name) and a two-click `↻` reload
  (ConfirmButton, disabled offline/permission). Mobile: `↻ 重新加载 mesh 定义` added to
  the 更多 sheet (pagination stays △ — the mobile mesh switcher is a select listing all).
  Navigation index (`?index=1`) 01 row note updated to reflect the completed coverage.
  All existing app-shell all-state desktop/mobile coverage intact.
