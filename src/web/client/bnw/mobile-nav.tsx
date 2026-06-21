// Step 7.5-A — mobile shell navigation for the `/bnw/` console. Renders the bottom tab bar
// (运行态 / 看板 / 更多) and the full-screen "更多" management list, shown only below the `lg`
// breakpoint (`lg:hidden`); desktop keeps the existing left mesh nav + topbar links + sub-nav.
//
// Accepted deviation (lead-released 7.5-A): mockup 01 sketches 更多 as a bottom *sheet*; we
// ship it as a full-screen route list (no router change — a local overlay toggled from the
// bottom bar). Recorded in coverage/01-app-shell.md.
import { Badge, ConfirmButton, RouteLink } from "../ui/index";
import { bnwHref, type BnwRoute } from "../router";

// Management surfaces that live under 更多 on mobile (mirror of the desktop topbar nav +
// the left-nav "+ 新建" entry). Order matches the desktop topbar reading order.
const MORE_LINKS: { route: BnwRoute; label: string; icon: string }[] = [
  { route: { k: "assistant" }, label: "Mesh 助手", icon: "🤝" },
  { route: { k: "harnesses" }, label: "Harnesses", icon: "🧩" },
  { route: { k: "channels" }, label: "渠道", icon: "📡" },
  { route: { k: "doctor" }, label: "Doctor / 系统", icon: "🩺" },
  { route: { k: "settings" }, label: "设置", icon: "⚙️" },
  { route: { k: "notifications" }, label: "通知", icon: "🔔" },
  { route: { k: "newMesh" }, label: "新建 mesh", icon: "＋" },
];

// Routes reachable from 更多 → keep the 更多 tab visually active when one is current.
const MORE_KEYS = new Set<BnwRoute["k"]>([
  "assistant", "harnesses", "channels", "doctor", "settings", "notifications", "newMesh",
]);

function Tab({ label, icon, href, active, onClick }: { label: string; icon: string; href?: string; active: boolean; onClick?: () => void }) {
  const cls = `flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-xs ${active ? "text-text-primary font-medium" : "text-text-muted"}`;
  if (!href) {
    // No active mesh yet → tab is inert (no mesh to route to). Stays AA-legible.
    return (
      <span className={`${cls} opacity-60`} aria-disabled="true">
        <span aria-hidden="true" className="text-base leading-none">{icon}</span>
        {label}
      </span>
    );
  }
  return (
    <RouteLink href={href} active={active} unstyled className={cls} aria-label={label} onClick={onClick}>
      <span aria-hidden="true" className="text-base leading-none">{icon}</span>
      {label}
    </RouteLink>
  );
}

/**
 * Bottom tab bar (mobile only). 运行态 / 看板 route to the active mesh (or the first mesh as a
 * fallback); 更多 toggles the management overlay. Hidden at `lg` and up.
 */
export function BottomTabs({ route, tabMesh, moreOpen, onToggleMore, onNavigate }: {
  route: BnwRoute;
  tabMesh?: string;
  moreOpen: boolean;
  onToggleMore: () => void;
  onNavigate: () => void;
}) {
  const onRuntime = !moreOpen && route.k === "runtime";
  const onBoard = !moreOpen && route.k === "board";
  const moreActive = moreOpen || MORE_KEYS.has(route.k);
  return (
    <nav
      data-bnw-bottomtabs
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface-raised lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <Tab label="运行态" icon="▶" active={onRuntime} onClick={onNavigate}
        href={tabMesh ? bnwHref({ k: "runtime", mesh: tabMesh }) : undefined} />
      <Tab label="看板" icon="▤" active={onBoard} onClick={onNavigate}
        href={tabMesh ? bnwHref({ k: "board", mesh: tabMesh, view: "list", filters: {} }) : undefined} />
      <button
        type="button"
        data-bnw-more-toggle
        aria-expanded={moreOpen}
        onClick={onToggleMore}
        className={`flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-xs rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring ${moreActive ? "text-text-primary font-medium" : "text-text-muted"}`}
      >
        <span aria-hidden="true" className="text-base leading-none">☰</span>
        更多
      </button>
    </nav>
  );
}

/**
 * Full-screen 更多 management list (mobile only). Overlays the surface stage; each row is a real
 * RouteLink that SPA-navigates and closes the overlay. Hidden at `lg` and up.
 */
export function MoreMenu({ onClose, unreadCount, onReload, reloadDisabled, reloading }: {
  onClose: () => void;
  unreadCount: number;
  onReload: () => void;
  reloadDisabled: boolean;
  reloading: boolean;
}) {
  return (
    <div data-bnw-more className="absolute inset-0 z-20 flex flex-col bg-surface lg:hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="font-semibold">更多</span>
        <button type="button" onClick={onClose} aria-label="关闭更多" className="rounded-sm px-2 py-1 text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring">✕</button>
      </div>
      <ul className="flex-1 overflow-auto pb-24">
        {MORE_LINKS.map((l) => (
          <li key={`${l.route.k}:${l.label}`}>
            <RouteLink
              href={bnwHref(l.route)}
              unstyled
              onClick={onClose}
              className="flex items-center gap-3 border-b border-border px-4 py-3.5 text-sm text-text-primary"
            >
              <span aria-hidden="true" className="w-5 text-center text-base leading-none">{l.icon}</span>
              <span className="flex-1">{l.label}</span>
              {l.route.k === "notifications" && unreadCount > 0
                ? <Badge count={unreadCount} max={99} tone="urgent" label="未读通知" />
                : null}
              <span aria-hidden="true" className="text-text-muted">›</span>
            </RouteLink>
          </li>
        ))}
        {/* #20 — reload mesh definitions (mobile lives in 更多 per coverage 01; two-click confirm) */}
        <li className="flex items-center gap-3 border-b border-border px-4 py-3 text-sm text-text-primary">
          <span aria-hidden="true" className="w-5 text-center text-base leading-none">↻</span>
          <span className="flex-1">重新加载 mesh 定义</span>
          <ConfirmButton size="sm" variant="ghost" confirmLabel="重新加载?" disabled={reloadDisabled} busy={reloading} aria-label="reload mesh definitions (mobile)" onConfirm={onReload}>↻</ConfirmButton>
        </li>
      </ul>
    </div>
  );
}
