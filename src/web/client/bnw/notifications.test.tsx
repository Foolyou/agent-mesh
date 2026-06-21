// Step 7.4-C.2 — focused SSR tests for the /bnw Notifications center (mockup 10). Renders against
// folded GatewayState.notifications + a stub store (getUpgrade/wsConnected). Live WS deltas + the
// unread-badge integration are covered by bnw.e2e.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BnwNotifications } from "./notifications";
import type { GatewayState, NotificationRecord } from "../../types";
import type { Store } from "../store";

const ITEMS: NotificationRecord[] = [
  { id: "ntf-3", type: "harness-upgrade", severity: "warning", title: "codex 有更新 v1.2.3 → v1.2.5", body: "更新并重启", createdAt: new Date().toISOString(), dedupKey: "h", source: { surface: "harnesses" } },
  { id: "ntf-2", type: "device-auth", severity: "info", title: "新设备申请授权", createdAt: new Date().toISOString(), dedupKey: "d", source: { surface: "settings", tab: "devices" } },
  { id: "ntf-1", type: "system-alert", severity: "info", title: "auto-compact", createdAt: new Date(Date.now() - 3600_000).toISOString(), readAt: new Date().toISOString(), dedupKey: "s" },
];
const state = (items: NotificationRecord[] = ITEMS): GatewayState => ({
  meshes: [], assistant: { status: "absent", transcript: [] }, perMesh: {},
  notifications: { items, unreadCount: items.filter((n) => !n.readAt).length, revision: 1 },
});
const stub = (o: { upgrade?: any; connected?: boolean } = {}): Store => ({
  subscribe: () => () => {}, getUpgrade: () => o.upgrade ?? { available: false }, wsConnected: () => o.connected ?? true,
  markNotificationRead: async () => ({}), markAllNotificationsRead: async () => ({}),
} as unknown as Store);

test("notifications page: list + unread/history split + filters + mark-all", () => {
  const out = renderToStaticMarkup(<BnwNotifications store={stub()} state={state()} />);
  expect(out).toContain('data-notifications="center"');
  expect(out).toContain("通知 Notifications");
  expect(out).toContain('aria-label="notification filters"');
  expect(out).toContain('aria-label="filter harness-upgrade"'); // category chips
  expect(out).toContain('aria-label="mark all read"');
  // unread items render with dot + chip + follow + mark-read; read item in history split
  expect(out).toContain("data-notif");
  expect(out).toContain("data-unread-dot");
  expect(out).toContain("codex 有更新 v1.2.3 → v1.2.5");
  expect(out).toContain("历史 / 已读"); // read item present → history divider
  expect(out).toContain('aria-label="mark read ntf-3"');
});

test("follow action resolves via structured source → bnwHref (no arbitrary URL)", () => {
  const out = renderToStaticMarkup(<BnwNotifications store={stub()} state={state()} />);
  expect(out).toContain('href="/bnw/harnesses"');               // harness-upgrade → harnesses
  expect(out).toContain('href="/bnw/settings?tab=devices"');     // device-auth → settings/devices
  expect(out).not.toMatch(/href="https?:/);                       // never an external URL
});

test("frontend-update is a client-synthesized row (reload action, no mark-read, not persisted)", () => {
  const out = renderToStaticMarkup(<BnwNotifications store={stub({ upgrade: { available: true, current: "a", next: "b" } })} state={state([])} />);
  expect(out).toContain('data-notif-type="frontend-update"');
  expect(out).toContain("控制台前端有新版本");
  expect(out).toContain('aria-label="reload for update"');
  expect(out).not.toContain('aria-label="mark read __frontend-update"'); // synthetic has no server mark-read
});

test("empty state when no items and no upgrade", () => {
  expect(renderToStaticMarkup(<BnwNotifications store={stub()} state={state([])} />)).toContain("全部已读");
});

test("mark-all gates on the GLOBAL unread count, not the filtered/synthetic view", () => {
  // synthetic frontend-update is the only unread row, but the server unreadCount is 0 →
  // mark-all stays DISABLED (the synthetic row is not server-persisted / read-markable).
  const out = renderToStaticMarkup(<BnwNotifications store={stub({ upgrade: { available: true, current: "a", next: "b" } })} state={state([])} />);
  expect(out).toContain('data-notif-type="frontend-update"'); // synthetic row visible (unread)
  // matches the real `disabled` ATTRIBUTE (disabled=""), not the `disabled:` tailwind utility class
  expect(out).toMatch(/aria-label="mark all read"[^>]*disabled=""/); // mark-all disabled (unreadCount 0)
  // with a real server unread, mark-all is enabled regardless of filter/synthetic
  const out2 = renderToStaticMarkup(<BnwNotifications store={stub()} state={state()} />);
  expect(out2).not.toMatch(/aria-label="mark all read"[^>]*disabled=""/);
});

test("offline: reconnect banner + mark-all disabled", () => {
  const out = renderToStaticMarkup(<BnwNotifications store={stub({ connected: false })} state={state()} />);
  expect(out).toContain("连接已断开");
  expect(out).toMatch(/aria-label="mark all read"[^>]*disabled=""/);
});
