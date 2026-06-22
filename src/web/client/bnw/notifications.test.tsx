// Step 7.4-C.2 — focused SSR tests for the /bnw Notifications center (mockup 10). Renders against
// folded GatewayState.notifications + a stub store (getUpgrade/wsConnected). Live WS deltas + the
// unread-badge integration are covered by bnw.e2e.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { BnwNotifications } from "./notifications";
import type { GatewayState, NotificationRecord } from "../../types";
import type { Store } from "../store";
import { I18nContext, translate, type TFn } from "../i18n";

// App-copy flows through t(); render under an en I18nContext so assertions read English (notification
// title/body fixtures stay as data — they are intentionally not translated). e2e covers zh.
const EN = { lang: "en" as const, t: ((k, vars) => translate(k, "en", vars)) as TFn };
const r = (el: ReactElement) => renderToStaticMarkup(<I18nContext.Provider value={EN}>{el}</I18nContext.Provider>);

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
  const out = r(<BnwNotifications store={stub()} state={state()} />);
  expect(out).toContain('data-notifications="center"');
  expect(out).toContain("Notifications");
  expect(out).toContain('aria-label="notification filters"');
  expect(out).toContain('aria-label="filter harness-upgrade"'); // category chips
  expect(out).toContain('aria-label="mark all read"');
  // unread items render with dot + chip + follow + mark-read; read item in history split
  expect(out).toContain("data-notif");
  expect(out).toContain("data-unread-dot");
  expect(out).toContain("codex 有更新 v1.2.3 → v1.2.5");
  expect(out).toContain("history / read"); // read item present → history divider
  expect(out).toContain('aria-label="mark read ntf-3"');
});

test("follow action resolves via structured source → bnwHref (no arbitrary URL)", () => {
  const out = r(<BnwNotifications store={stub()} state={state()} />);
  expect(out).toContain('href="/bnw/harnesses"');               // harness-upgrade → harnesses
  expect(out).toContain('href="/bnw/settings?tab=devices"');     // device-auth → settings/devices
  expect(out).not.toMatch(/href="https?:/);                       // never an external URL
});

test("frontend-update is a client-synthesized row (reload action, no mark-read, not persisted)", () => {
  const out = r(<BnwNotifications store={stub({ upgrade: { available: true, current: "a", next: "b" } })} state={state([])} />);
  expect(out).toContain('data-notif-type="frontend-update"');
  expect(out).toContain("A new console frontend is available");
  expect(out).toContain('aria-label="reload for update"');
  expect(out).not.toContain('aria-label="mark read __frontend-update"'); // synthetic has no server mark-read
});

test("empty state when no items and no upgrade", () => {
  expect(r(<BnwNotifications store={stub()} state={state([])} />)).toContain("all caught up");
});

test("mark-all gates on the GLOBAL unread count, not the filtered/synthetic view", () => {
  // synthetic frontend-update is the only unread row, but the server unreadCount is 0 →
  // mark-all stays DISABLED (the synthetic row is not server-persisted / read-markable).
  const out = r(<BnwNotifications store={stub({ upgrade: { available: true, current: "a", next: "b" } })} state={state([])} />);
  expect(out).toContain('data-notif-type="frontend-update"'); // synthetic row visible (unread)
  // matches the real `disabled` ATTRIBUTE (disabled=""), not the `disabled:` tailwind utility class
  expect(out).toMatch(/aria-label="mark all read"[^>]*disabled=""/); // mark-all disabled (unreadCount 0)
  // with a real server unread, mark-all is enabled regardless of filter/synthetic
  const out2 = r(<BnwNotifications store={stub()} state={state()} />);
  expect(out2).not.toMatch(/aria-label="mark all read"[^>]*disabled=""/);
});

test("offline: mark-all disabled (banner is now the unified shell-level treatment, 7.5-C)", () => {
  const out = r(<BnwNotifications store={stub({ connected: false })} state={state()} />);
  // the per-surface offline banner moved to the shell (BnwApp) in 7.5-C; the surface keeps
  // disabling its own mutation (mark-all) via `offline`.
  expect(out).not.toContain("连接已断开");
  expect(out).toMatch(/aria-label="mark all read"[^>]*disabled=""/);
});
