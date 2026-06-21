// Step 7.0 — new `/bnw/` console: independent shell skeleton + route switch. Built from
// the C5–C8 component library (../ui) and the approved mockup shell structure. It shares
// the DATA layer (store / WS / API) with the old UI but is a SEPARATE view tree — it does
// NOT import or mutate the old view components (MeshDetail/BoardPanel/Sidebar/…). Surfaces
// render placeholders in 7.0; later phases (7.1+) fill them with real wired views.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createStore, useStore, useConnected, type Store } from "../store";
import {
  Badge, Button, Cluster, ConfirmButton, EmptyState, PanelFrame, RouteLink, Select, Spinner,
  StatusListRow, type Status,
} from "../ui/index";
import type { MeshStatus } from "../../types";
import { useRoute, navigate, bnwHref, type BnwRoute } from "../router";
import { BottomTabs, MoreMenu } from "./mobile-nav";
import { BnwErrorBoundary } from "./error-boundary";
import { RuntimeOverview, RuntimeFocus } from "./runtime";
import { MeshCanvas } from "./canvas";
import { BnwBoard } from "./board";
import { BnwNewMesh } from "./new-mesh";
import { BnwAssistant } from "./assistant";
import { BnwDoctor } from "./doctor";
import { BnwHarnesses } from "./harnesses";
import { BnwChannels } from "./channels";
import { BnwFileViewer } from "./file-viewer";
import { BnwSettings } from "./settings";
import { BnwNotifications } from "./notifications";
import { loadDefaultView } from "./prefs";

// Map the gateway MeshStatus → the C5 StatusChip vocabulary used by the component library.
function meshDot(s: MeshStatus): Status {
  switch (s) {
    case "running": return "working";
    case "starting": return "attention";
    case "dead": return "blocked";
    case "stopped": default: return "idle";
  }
}

const SURFACE_TITLE: Record<BnwRoute["k"], string> = {
  home: "Home",
  runtime: "运行态 A",
  board: "看板 C",
  newMesh: "新建 mesh",
  assistant: "Mesh Assistant B",
  harnesses: "Harnesses",
  channels: "Channels",
  doctor: "Doctor / 系统",
  settings: "Settings",
  notifications: "Notifications",
  file: "File / Artifact",
  notFound: "Not found",
};

// 7.0 placeholder body for a surface — names the resolved route so route-switching is
// visibly distinct per path. Real wired content lands in 7.1–7.5.
function SurfacePlaceholder({ route }: { route: BnwRoute }) {
  const detail = (() => {
    switch (route.k) {
      case "runtime": return route.canvas ? `canvas · ${route.mesh}` : route.agent ? `${route.mesh} · agent ${route.agent}${route.full ? " · full" : ""}` : `${route.mesh} · overview`;
      case "board": return route.issue ? `${route.mesh} · issue #${route.issue}` : `${route.mesh} · ${route.view}`;
      case "newMesh": return route.editOf ? `edit ${route.editOf}` : "create";
      case "file": return `${route.mesh} · ${route.agent} · ${route.kind} · ${route.path}`;
      case "settings": return route.tab ?? "appearance";
      default: return "";
    }
  })();
  return (
    <PanelFrame title={SURFACE_TITLE[route.k]} description={detail || undefined}>
      <EmptyState
        title={`${SURFACE_TITLE[route.k]} — 7.0 占位`}
        description="路由地基已就绪；本表面的真实接线将在后续阶段（7.1–7.5）落地。"
      />
    </PanelFrame>
  );
}

// 7.5-C — in-app SPA 404 matching surface-13's not-found-in-shell treatment (🧭 card +
// 返回控制台). The shell chrome stays mounted; only the stage shows the not-found view.
function NotFound({ path }: { path: string }) {
  return (
    <PanelFrame title="Not found">
      <div data-bnw-not-found className="flex flex-col items-center gap-2 py-10 text-center">
        <span className="text-3xl" aria-hidden="true">🧭</span>
        <h2 className="text-base font-semibold text-text-primary">404 · 页面不存在</h2>
        <p className="max-w-md text-xs text-text-muted">没有匹配的 /bnw 路由：<code className="break-all font-mono text-text-secondary">{path}</code></p>
        <RouteLink href={bnwHref({ k: "home" })} unstyled className="mt-1 inline-flex items-center rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover">返回控制台</RouteLink>
      </div>
    </PanelFrame>
  );
}

function ManageLink({ route, label }: { route: BnwRoute; label: string }) {
  return <RouteLink href={bnwHref(route)} className="text-sm">{label}</RouteLink>;
}

// 7.5-C — test seam for the stage ErrorBoundary: throws during render iff `window.__bnwForceError`
// is set, so e2e can verify a surface crash is contained + that clearing the flag and resetting
// the boundary recovers. Inert in production (no one sets the global). Re-reads the live flag on
// every render, so a boundary reset after the flag is cleared renders the real surface again.
function MaybeThrow({ children }: { children: ReactNode }) {
  if (typeof window !== "undefined" && (window as any).__bnwForceError) {
    throw new Error("forced surface error (test seam)");
  }
  return <>{children}</>;
}

export function BnwApp() {
  const storeRef = useRef<Store | null>(null);
  if (!storeRef.current) {
    storeRef.current = createStore();
    if (typeof window !== "undefined") (window as any).__meshStore = storeRef.current;
  }
  const store = storeRef.current;
  const state = useStore(store);
  const connected = useConnected(store);
  const route = useRoute();
  // 7.5-A — mobile "更多" overlay (local state, not a route). Any navigation closes it.
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { setMoreOpen(false); }, [route]);

  // Landing: `/bnw/` → the default-view pref (7.4-B) of the first mesh once meshes arrive
  // (replace, so back works). Defaults to runtime; honors a saved board preference.
  useEffect(() => {
    if (route.k === "home" && state.meshes.length) {
      const mesh = state.meshes[0].name;
      const dest = loadDefaultView() === "board" ? { k: "board" as const, mesh, view: "list" as const, filters: {} } : { k: "runtime" as const, mesh };
      navigate(dest, { replace: true });
    }
  }, [route.k, state.meshes]);

  const activeMesh = route.k === "runtime" || route.k === "board" || route.k === "file"
    ? route.mesh
    : route.k === "newMesh" ? route.editOf : undefined;
  // 7.5-A — bottom tabs / mobile mesh select need a target even on management surfaces;
  // fall back to the first mesh. Switching the mobile select preserves runtime⇄board.
  const tabMesh = activeMesh ?? state.meshes[0]?.name;
  const switchMesh = (m: string) => {
    if (!m) return;
    navigate(route.k === "board" ? { k: "board", mesh: m, view: "list", filters: {} } : { k: "runtime", mesh: m });
  };
  // #19 — desktop left-nav mesh-list pagination (4/page, ‹ ›; mobile select lists all).
  const PER_PAGE = 4;
  const [meshPage, setMeshPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(state.meshes.length / PER_PAGE));
  useEffect(() => { if (meshPage > pageCount - 1) setMeshPage(pageCount - 1); }, [pageCount, meshPage]);
  const pageMeshes = state.meshes.slice(meshPage * PER_PAGE, meshPage * PER_PAGE + PER_PAGE);
  // #20 — reload mesh definitions from the server (two-click confirm; disabled offline).
  const [reloading, setReloading] = useState(false);
  const doReload = async () => { setReloading(true); try { await store.reload(); } finally { setReloading(false); } };

  let body: ReactNode;
  if (route.k === "notFound") body = <NotFound path={route.path} />;
  else if (route.k === "home") body = <PanelFrame title="Home"><div className="flex items-center gap-2 text-sm text-text-muted"><Spinner size={14} label="loading" /> 正在进入默认 mesh…</div></PanelFrame>;
  // 7.1 — Runtime A wired to the real store: overview + focus (A/B) + canvas (C).
  // Non-runtime surfaces remain 7.0 placeholders.
  else if (route.k === "runtime" && route.canvas) body = <MeshCanvas store={store} state={state} mesh={route.mesh} />;
  else if (route.k === "runtime" && route.agent) body = <RuntimeFocus store={store} state={state} mesh={route.mesh} agent={route.agent} full={!!route.full} />;
  else if (route.k === "runtime") body = <RuntimeOverview store={store} state={state} mesh={route.mesh} />;
  // 7.2 — Board C wired to the real store.board (list/kanban/detail + C4 filter shell).
  else if (route.k === "board") body = <BnwBoard store={store} state={state} mesh={route.mesh} route={route} />;
  // 7.3 — new/edit-mesh builder + Mesh Assistant B (real defineMesh / promptAssistant).
  else if (route.k === "newMesh") body = <BnwNewMesh store={store} state={state} route={route} />;
  else if (route.k === "assistant") body = <BnwAssistant store={store} state={state} full={!!route.full} />;
  // 7.4-A — Doctor / system wired to real diagnostics (fetchDoctor + fetchPsDetail + reap/restart).
  else if (route.k === "doctor") body = <BnwDoctor store={store} state={state} />;
  // 7.4-A.2a — Harnesses wired to real probe/install/reprobe/respawn.
  else if (route.k === "harnesses") body = <BnwHarnesses store={store} />;
  // 7.4-A.2b-i — Channels (Feishu) wired to real status/bindings/sync/provision (Option B).
  else if (route.k === "channels") body = <BnwChannels store={store} />;
  // 7.4-A.2b-ii — File / artifact viewer (deep-linkable; markdown/code/image + lightbox).
  else if (route.k === "file") body = <BnwFileViewer route={route} />;
  // 7.4-B — Settings (appearance/language/prefs/devices via ?tab).
  else if (route.k === "settings") body = <BnwSettings route={route} />;
  // 7.4-C.2 — Notifications center (real folded state + synthetic frontend-update row).
  else if (route.k === "notifications") body = <BnwNotifications store={store} state={state} />;
  else body = <SurfacePlaceholder route={route} />;

  return (
    <div data-bnw="shell" data-bnw-surface={route.k} className="flex h-[100dvh] flex-col bg-surface text-text-primary font-sans">
      {/* topbar */}
      <header className="flex items-center gap-3 border-b border-border bg-surface-raised px-4 py-2.5">
        <span className="inline-flex items-center gap-1.5 font-semibold"><span aria-hidden="true">◆</span> Mesh</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-text-muted" aria-label={connected ? "connected" : "disconnected"}>
          <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-success" : "bg-danger"}`} aria-hidden="true" />
          {connected ? "connected" : "offline"}
        </span>
        {/* mobile: a mesh switcher in the topbar (desktop uses the left nav rows) */}
        {state.meshes.length > 0 ? (
          <Select
            aria-label="选择 mesh"
            className="lg:hidden"
            value={tabMesh ?? ""}
            onChange={(e) => switchMesh(e.target.value)}
          >
            {!tabMesh ? <option value="">选择 mesh…</option> : null}
            {state.meshes.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
          </Select>
        ) : null}
        <span className="flex-1" aria-hidden="true" />
        {/* desktop management links; on mobile these fold into the 更多 bottom tab */}
        <nav aria-label="management" className="hidden items-center gap-3 lg:flex">
          <ManageLink route={{ k: "assistant" }} label="助手" />
          <ManageLink route={{ k: "harnesses" }} label="Harness" />
          <ManageLink route={{ k: "channels" }} label="渠道" />
          <ManageLink route={{ k: "doctor" }} label="Doctor" />
          <ManageLink route={{ k: "settings" }} label="设置" />
        </nav>
        <RouteLink href={bnwHref({ k: "notifications" })} aria-label="通知" className="relative inline-flex items-center gap-1">
          <span aria-hidden="true">🔔</span>
          {/* 7.4-C.2 — real unread count from the folded notifications snapshot/deltas */}
          {(state.notifications?.unreadCount ?? 0) > 0 ? <Badge count={state.notifications!.unreadCount} max={99} tone="urgent" label="未读通知" /> : null}
        </RouteLink>
      </header>

      {/* 7.5-C — unified shell-level offline/reconnect banner (surface-13 contract). WS auto-
          reconnects with backoff; this is transient (no persistence) and offers an immediate
          retry. Surfaces still disable their own mutations via `offline` independently. */}
      {!connected ? (
        <div data-bnw-offline role="status" className="flex flex-wrap items-center gap-2 border-b border-border bg-warning-subtle px-4 py-1.5 text-xs text-warning">
          <Spinner size={12} label="reconnecting" />
          <span>连接已断开 — 正在重连…（显示最近已知内容，变更已禁用）</span>
          <span className="flex-1" aria-hidden="true" />
          <Button size="sm" variant="ghost" aria-label="reconnect now" onClick={() => store.reconnect()}>立即重连</Button>
        </div>
      ) : null}

      {/* body: left nav · stage · right context. `relative` anchors the mobile 更多 overlay. */}
      <div className="relative flex min-h-0 flex-1">
        {/* desktop left mesh nav — fully hidden on mobile (the topbar select + bottom tabs cover it) */}
        <nav aria-label="meshes" className="hidden w-[232px] shrink-0 flex-col gap-1 overflow-auto border-r border-border bg-surface-raised p-2 lg:flex">
          <div className="mb-1 flex items-center justify-between gap-1 px-1">
            <span className="text-xs uppercase tracking-wider text-text-muted">meshes</span>
            <div className="flex items-center gap-1">
              {/* #20 — reload mesh definitions (two-click confirm; disabled offline) */}
              <ConfirmButton size="sm" variant="ghost" confirmLabel="重新加载?" disabled={!connected} busy={reloading} aria-label="reload mesh definitions" onConfirm={() => void doReload()}>↻</ConfirmButton>
              <RouteLink href={bnwHref({ k: "newMesh" })} className="text-xs">+ 新建</RouteLink>
            </div>
          </div>
          {state.meshes.length === 0 ? (
            <div className="px-1 py-2 text-xs text-text-muted">{connected ? "无 mesh" : "连接中…"}</div>
          ) : (
            pageMeshes.map((m) => (
              <StatusListRow
                key={m.name}
                status={meshDot(m.status)}
                title={m.name}
                href={bnwHref({ k: "runtime", mesh: m.name })}
                active={m.name === activeMesh}
              />
            ))
          )}
          {/* #19 — pagination (only when >1 page) */}
          {pageCount > 1 ? (
            <div data-bnw-mesh-pager className="mt-1 flex items-center justify-between px-1 text-xs text-text-muted">
              <Button size="sm" variant="ghost" iconOnly disabled={meshPage <= 0} aria-label="previous mesh page" onClick={() => setMeshPage((p) => Math.max(0, p - 1))}>‹</Button>
              <span className="tabular-nums" aria-label={`mesh page ${meshPage + 1} of ${pageCount}`}>{meshPage + 1}/{pageCount}</span>
              <Button size="sm" variant="ghost" iconOnly disabled={meshPage >= pageCount - 1} aria-label="next mesh page" onClick={() => setMeshPage((p) => Math.min(pageCount - 1, p + 1))}>›</Button>
            </div>
          ) : null}
        </nav>

        {/* extra bottom padding on mobile so the fixed bottom tab bar never covers content */}
        <main className="min-w-0 flex-1 overflow-auto p-3 pb-20 lg:pb-3">
          {/* desktop mesh-scoped sub-nav (运行态/看板/画布); on mobile this folds into the bottom tabs */}
          {activeMesh && route.k !== "notFound" ? (
            <div className="mb-3 hidden lg:block">
              <Cluster>
                <RouteLink href={bnwHref({ k: "runtime", mesh: activeMesh })} active={route.k === "runtime"} className="text-sm">运行态</RouteLink>
                <RouteLink href={bnwHref({ k: "board", mesh: activeMesh, view: "list", filters: {} })} active={route.k === "board"} className="text-sm">看板</RouteLink>
                <RouteLink href={bnwHref({ k: "runtime", mesh: activeMesh, canvas: true })} active={route.k === "runtime" && (route as any).canvas} className="text-sm">画布</RouteLink>
              </Cluster>
            </div>
          ) : null}
          {/* 7.5-C — stage-level boundary: a surface render crash shows a retry card here while
              the topbar / nav / sub-nav / bottom tabs stay alive. resetKey=route → auto-recovers
              on navigation. */}
          <BnwErrorBoundary resetKey={bnwHref(route)}><MaybeThrow>{body}</MaybeThrow></BnwErrorBoundary>
        </main>
        {/* No generic right-context stub — each surface owns its own context (e.g. runtime
            focus renders an `<agent> · activity` panel; overview/canvas are full-width). */}
        {/* 7.5-A — mobile 更多 overlay covers the body region (under the fixed bottom tabs) */}
        {moreOpen ? <MoreMenu onClose={() => setMoreOpen(false)} unreadCount={state.notifications?.unreadCount ?? 0} onReload={() => void doReload()} reloadDisabled={!connected} reloading={reloading} /> : null}
      </div>

      {/* 7.5-A — mobile bottom tab bar (hidden at lg+) */}
      <BottomTabs
        route={route}
        tabMesh={tabMesh}
        moreOpen={moreOpen}
        onToggleMore={() => setMoreOpen((v) => !v)}
        onNavigate={() => setMoreOpen(false)}
      />
    </div>
  );
}
