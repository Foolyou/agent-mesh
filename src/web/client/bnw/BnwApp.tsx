// Step 7.0 — new `/bnw/` console: independent shell skeleton + route switch. Built from
// the C5–C8 component library (../ui) and the approved mockup shell structure. It shares
// the DATA layer (store / WS / API) with the old UI but is a SEPARATE view tree — it does
// NOT import or mutate the old view components (MeshDetail/BoardPanel/Sidebar/…). Surfaces
// render placeholders in 7.0; later phases (7.1+) fill them with real wired views.
import { useEffect, useRef, type ReactNode } from "react";
import { createStore, useStore, useConnected, type Store } from "../store";
import {
  Badge, Cluster, EmptyState, PanelFrame, RouteLink, Spinner,
  StatusListRow, type Status,
} from "../ui/index";
import type { MeshStatus } from "../../types";
import { useRoute, navigate, bnwHref, type BnwRoute } from "../router";
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

function NotFound({ path }: { path: string }) {
  return (
    <PanelFrame title="Not found">
      <EmptyState
        title="页面不存在"
        description={`没有匹配的 /bnw 路由：${path}`}
        action={<RouteLink href={bnwHref({ k: "home" })}>返回首页</RouteLink>}
      />
    </PanelFrame>
  );
}

function ManageLink({ route, label }: { route: BnwRoute; label: string }) {
  return <RouteLink href={bnwHref(route)} className="text-sm">{label}</RouteLink>;
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
        <span className="flex-1" aria-hidden="true" />
        <nav aria-label="management" className="flex items-center gap-3">
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

      {/* body: left nav · stage · right context */}
      <div className="flex min-h-0 flex-1">
        <nav aria-label="meshes" className="flex w-[232px] shrink-0 flex-col gap-1 overflow-auto border-r border-border bg-surface-raised p-2">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-xs uppercase tracking-wider text-text-muted">meshes</span>
            <RouteLink href={bnwHref({ k: "newMesh" })} className="text-xs">+ 新建</RouteLink>
          </div>
          {state.meshes.length === 0 ? (
            <div className="px-1 py-2 text-xs text-text-muted">{connected ? "无 mesh" : "连接中…"}</div>
          ) : (
            state.meshes.map((m) => (
              <StatusListRow
                key={m.name}
                status={meshDot(m.status)}
                title={m.name}
                href={bnwHref({ k: "runtime", mesh: m.name })}
                active={m.name === activeMesh}
              />
            ))
          )}
        </nav>

        <main className="min-w-0 flex-1 overflow-auto p-3">
          {/* mesh-scoped sub-nav so runtime/board/canvas switch visibly */}
          {activeMesh && route.k !== "notFound" ? (
            <div className="mb-3">
              <Cluster>
                <RouteLink href={bnwHref({ k: "runtime", mesh: activeMesh })} active={route.k === "runtime"} className="text-sm">运行态</RouteLink>
                <RouteLink href={bnwHref({ k: "board", mesh: activeMesh, view: "list", filters: {} })} active={route.k === "board"} className="text-sm">看板</RouteLink>
                <RouteLink href={bnwHref({ k: "runtime", mesh: activeMesh, canvas: true })} active={route.k === "runtime" && (route as any).canvas} className="text-sm">画布</RouteLink>
              </Cluster>
            </div>
          ) : null}
          {body}
        </main>
        {/* No generic right-context stub — each surface owns its own context (e.g. runtime
            focus renders an `<agent> · activity` panel; overview/canvas are full-width). */}
      </div>
    </div>
  );
}
