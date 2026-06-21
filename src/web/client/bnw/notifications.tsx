// Step 7.4-C.2 — Notifications center page (mockup 10). Reads the folded snapshot/delta state
// (state.notifications) + the client-synthesized frontend-update row (store.getUpgrade); mutates
// via store.markNotificationRead / markAllNotificationsRead. Follow actions resolve ONLY through a
// structured source → bnwHref (never an arbitrary URL). Independent /bnw view.
import { useState } from "react";
import { Badge, Button, Cluster, EmptyState, PanelFrame, RouteLink, Spinner, StatusChip, type Status } from "../ui/index";
import { useUpgrade, useConnected, type Store } from "../store";
import { bnwHref, type BnwRoute } from "../router";
import type { GatewayState, NotificationRecord, NotificationSource, NotificationType } from "../../types";

const TYPE_META: Record<NotificationType, { icon: string; tone: Status; chip: string }> = {
  "harness-upgrade": { icon: "⬆", tone: "attention", chip: "harness" },
  "frontend-update": { icon: "⟳", tone: "ready", chip: "update" },
  "service-status": { icon: "🛰", tone: "working", chip: "service" },
  "system-alert": { icon: "⚙", tone: "idle", chip: "system" },
  "device-auth": { icon: "🔑", tone: "attention", chip: "device" },
};
const FILTERS: { id: NotificationType | "all"; label: string }[] = [
  { id: "all", label: "全部" }, { id: "harness-upgrade", label: "harness" }, { id: "frontend-update", label: "update" },
  { id: "service-status", label: "service" }, { id: "system-alert", label: "system" }, { id: "device-auth", label: "device" },
];
const FRONTEND_UPDATE_ID = "__frontend-update";

/** Structured source → /bnw route. Returns undefined for the synthetic update row (reload action). */
function sourceRoute(s?: NotificationSource): BnwRoute | undefined {
  if (!s) return undefined;
  switch (s.surface) {
    case "harnesses": return { k: "harnesses" };
    case "doctor": return { k: "doctor" };
    case "channels": return { k: "channels" };
    case "settings": return { k: "settings", tab: s.tab };
    case "runtime": return { k: "runtime", mesh: s.mesh, agent: s.agent };
    case "board": return { k: "board", mesh: s.mesh, view: "list", filters: {}, issue: s.issue };
    default: return undefined;
  }
}
function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function BnwNotifications({ store, state }: { store: Store; state: GatewayState }) {
  const upgrade = useUpgrade(store);
  const connected = useConnected(store);
  const [filter, setFilter] = useState<NotificationType | "all">("all");
  const offline = !connected;

  const server = state.notifications?.items ?? [];
  // Client-synthesized ephemeral frontend-update row (decision #1: not server-persisted).
  const synthetic: NotificationRecord[] = upgrade.available
    ? [{ id: FRONTEND_UPDATE_ID, type: "frontend-update", severity: "info", title: "控制台前端有新版本", body: "刷新以加载最新 WebUI", createdAt: new Date().toISOString(), dedupKey: FRONTEND_UPDATE_ID }]
    : [];
  const all = [...synthetic, ...server];
  const list = filter === "all" ? all : all.filter((n) => n.type === filter);
  const unread = list.filter((n) => !n.readAt);
  const read = list.filter((n) => !!n.readAt);
  const unreadCount = state.notifications?.unreadCount ?? 0;

  const actions = (
    <Cluster>
      {unreadCount > 0 ? <Badge count={unreadCount} max={99} tone="urgent" /> : null}
      {/* mark-all gates on the SERVER/global unread count — never the filtered view, and never the
          client-synthesized frontend-update row (which is not server-persisted / read-markable). */}
      <Button size="sm" variant="ghost" disabled={offline || unreadCount === 0} aria-label="mark all read" onClick={() => void store.markAllNotificationsRead()}>全部已读</Button>
    </Cluster>
  );

  return (
    <PanelFrame title="通知 Notifications" actions={actions} className="h-full" bodyClassName="min-h-0">
      <div data-notifications="center" className="flex min-h-0 flex-col">
        {offline ? (
          <div role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-warning-subtle px-3 py-1.5 text-xs text-warning">
            <Spinner size={12} label="reconnecting" /> 连接已断开 — 显示最近已知通知；标记已读已禁用。
          </div>
        ) : null}
        <nav aria-label="notification filters" className="mb-3">
          {/* 7.5-B C1: chips wrap to a second row on mobile instead of overflowing/clipping */}
          <Cluster className="flex-wrap">
            {FILTERS.map((f) => (
              <Button key={f.id} size="sm" variant={f.id === filter ? "secondary" : "ghost"} aria-pressed={f.id === filter} aria-label={`filter ${f.id}`} onClick={() => setFilter(f.id)}>{f.label}</Button>
            ))}
          </Cluster>
        </nav>
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-2">
          {state.notifications === undefined && !offline ? (
            <div className="flex flex-col gap-2"><div className="h-12 animate-pulse rounded-lg bg-border" /><div className="h-12 animate-pulse rounded-lg bg-border" /></div>
          ) : all.length === 0 ? (
            <EmptyState icon={<span className="text-2xl">🎉</span>} title="全部已读" description="没有新的系统通知。harness 升级、前端更新、服务状态等会出现在这里。" />
          ) : list.length === 0 ? (
            <span className="px-1 py-2 text-xs text-text-muted">该分类下暂无通知。</span>
          ) : (
            <>
              {unread.map((n) => <NotifItem key={n.id} n={n} store={store} offline={offline} />)}
              {read.length ? (
                <>
                  <div className="mt-2 flex items-center gap-2 text-xs uppercase tracking-wider text-text-muted"><span>历史 / 已读</span><span className="h-px flex-1 bg-border" aria-hidden="true" /></div>
                  {read.map((n) => <NotifItem key={n.id} n={n} store={store} offline={offline} />)}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}

export function NotifItem({ n, store, offline }: { n: NotificationRecord; store: Store; offline: boolean }) {
  const meta = TYPE_META[n.type];
  const route = sourceRoute(n.source);
  const synthetic = n.id === FRONTEND_UPDATE_ID;
  const unread = !n.readAt;
  return (
    <div data-notif data-notif-type={n.type} data-unread={unread ? "1" : undefined} className={`flex flex-col gap-1 rounded-lg border px-3 py-2 ${unread ? "border-border-strong bg-surface-raised" : "border-border bg-surface-sunken"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {unread ? <span data-unread-dot aria-label="unread" className="h-2 w-2 rounded-full bg-accent" /> : <span className="h-2 w-2" aria-hidden="true" />}
        <StatusChip status={meta.tone} variant="soft" label={`${meta.icon} ${meta.chip}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{n.title}</span>
        <span className="shrink-0 text-xs text-text-muted">{relTime(n.createdAt)}</span>
      </div>
      {n.body ? <div className="pl-4 text-xs text-text-muted">{n.body}</div> : null}
      <div className="flex flex-wrap items-center gap-2 pl-4">
        {synthetic ? (
          <Button size="sm" variant="ghost" aria-label="reload for update" onClick={() => { try { location.reload(); } catch { /* SSR/no-window */ } }}>刷新更新 →</Button>
        ) : route ? (
          <RouteLink href={bnwHref(route)} className="text-xs">查看 →</RouteLink>
        ) : null}
        {unread && !synthetic ? <Button size="sm" variant="ghost" disabled={offline} aria-label={`mark read ${n.id}`} onClick={() => void store.markNotificationRead(n.id)}>标记已读</Button> : null}
      </div>
    </div>
  );
}
