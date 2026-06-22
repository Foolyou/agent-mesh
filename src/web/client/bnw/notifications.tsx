// Step 7.4-C.2 — Notifications center page (mockup 10). Reads the folded snapshot/delta state
// (state.notifications) + the client-synthesized frontend-update row (store.getUpgrade); mutates
// via store.markNotificationRead / markAllNotificationsRead. Follow actions resolve ONLY through a
// structured source → bnwHref (never an arbitrary URL). Independent /bnw view.
import { useState } from "react";
import { Badge, Button, Cluster, EmptyState, Icon, PanelFrame, RouteLink, StatusChip, type IconName, type Status } from "../ui/index";
import { useUpgrade, useConnected, type Store } from "../store";
import { bnwHref, type BnwRoute } from "../router";
import { useI18n } from "../i18n";
import type { GatewayState, NotificationRecord, NotificationSource, NotificationType } from "../../types";

const TYPE_META: Record<NotificationType, { icon: IconName; tone: Status; chip: string }> = {
  "harness-upgrade": { icon: "arrow-up", tone: "attention", chip: "harness" },
  "frontend-update": { icon: "refresh", tone: "ready", chip: "update" },
  "service-status": { icon: "broadcast", tone: "working", chip: "service" },
  "system-alert": { icon: "gear", tone: "idle", chip: "system" },
  "device-auth": { icon: "key", tone: "attention", chip: "device" },
};
// `cat` keys into bnw.nt.cat.* (harness stays English; all/update/service/system/device localize).
const FILTERS: { id: NotificationType | "all"; cat: string }[] = [
  { id: "all", cat: "all" }, { id: "harness-upgrade", cat: "harness" }, { id: "frontend-update", cat: "update" },
  { id: "service-status", cat: "service" }, { id: "system-alert", cat: "system" }, { id: "device-auth", cat: "device" },
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
  const { t } = useI18n();
  const upgrade = useUpgrade(store);
  const connected = useConnected(store);
  const [filter, setFilter] = useState<NotificationType | "all">("all");
  const offline = !connected;

  const server = state.notifications?.items ?? [];
  // Client-synthesized ephemeral frontend-update row (decision #1: not server-persisted).
  const synthetic: NotificationRecord[] = upgrade.available
    ? [{ id: FRONTEND_UPDATE_ID, type: "frontend-update", severity: "info", title: t("bnw.nt.feUpdateTitle"), body: t("bnw.nt.feUpdateBody"), createdAt: new Date().toISOString(), dedupKey: FRONTEND_UPDATE_ID }]
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
      <Button size="sm" variant="ghost" disabled={offline || unreadCount === 0} aria-label="mark all read" onClick={() => void store.markAllNotificationsRead()}>{t("bnw.nt.markAllRead")}</Button>
    </Cluster>
  );

  return (
    <PanelFrame title={t("bnw.nt.title")} actions={actions} className="h-full" bodyClassName="min-h-0">
      <div data-notifications="center" className="flex min-h-0 flex-col">
        {/* 7.5-C — offline/reconnect is now the unified shell-level banner (BnwApp); mark-read
            stays disabled via `offline` independently. */}
        <nav aria-label="notification filters" className="mb-3">
          {/* 7.5-B C1: chips wrap to a second row on mobile instead of overflowing/clipping */}
          <Cluster className="flex-wrap">
            {FILTERS.map((f) => (
              <Button key={f.id} size="sm" variant={f.id === filter ? "secondary" : "ghost"} aria-pressed={f.id === filter} aria-label={`filter ${f.id}`} onClick={() => setFilter(f.id)}>{t(`bnw.nt.cat.${f.cat}`)}</Button>
            ))}
          </Cluster>
        </nav>
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-2">
          {state.notifications === undefined && !offline ? (
            <div className="flex flex-col gap-2"><div className="h-12 animate-pulse rounded-lg bg-border" /><div className="h-12 animate-pulse rounded-lg bg-border" /></div>
          ) : all.length === 0 ? (
            <EmptyState icon={<Icon name="check-circle" size={28} className="text-success" />} title={t("bnw.nt.emptyTitle")} description={t("bnw.nt.emptyDesc")} />
          ) : list.length === 0 ? (
            <span className="px-1 py-2 text-xs text-text-muted">{t("bnw.nt.emptyFiltered")}</span>
          ) : (
            <>
              {unread.map((n) => <NotifItem key={n.id} n={n} store={store} offline={offline} />)}
              {read.length ? (
                <>
                  <div className="mt-2 flex items-center gap-2 text-xs uppercase tracking-wider text-text-muted"><span>{t("bnw.nt.historyDivider")}</span><span className="h-px flex-1 bg-border" aria-hidden="true" /></div>
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
  const { t } = useI18n();
  const meta = TYPE_META[n.type];
  const route = sourceRoute(n.source);
  const synthetic = n.id === FRONTEND_UPDATE_ID;
  const unread = !n.readAt;
  return (
    <div data-notif data-notif-type={n.type} data-unread={unread ? "1" : undefined} className={`flex flex-col gap-1 rounded-lg border px-3 py-2 ${unread ? "border-border-strong bg-surface-raised" : "border-border bg-surface-sunken"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {unread ? <span data-unread-dot aria-label="unread" className="h-2 w-2 rounded-full bg-accent" /> : <span className="h-2 w-2" aria-hidden="true" />}
        <Icon name={meta.icon} size={14} className="text-text-secondary" />
        <StatusChip status={meta.tone} variant="soft" label={t(`bnw.nt.cat.${meta.chip}`)} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{n.title}</span>
        <span className="shrink-0 text-xs text-text-muted">{relTime(n.createdAt)}</span>
      </div>
      {n.body ? <div className="pl-4 text-xs text-text-muted">{n.body}</div> : null}
      <div className="flex flex-wrap items-center gap-2 pl-4">
        {synthetic ? (
          <Button size="sm" variant="ghost" aria-label="reload for update" onClick={() => { try { location.reload(); } catch { /* SSR/no-window */ } }}>{t("bnw.nt.reloadUpdate")} →</Button>
        ) : route ? (
          <RouteLink href={bnwHref(route)} className="text-xs">{t("bnw.nt.view")} →</RouteLink>
        ) : null}
        {unread && !synthetic ? <Button size="sm" variant="ghost" disabled={offline} aria-label={`mark read ${n.id}`} onClick={() => void store.markNotificationRead(n.id)}>{t("bnw.nt.markRead")}</Button> : null}
      </div>
    </div>
  );
}
