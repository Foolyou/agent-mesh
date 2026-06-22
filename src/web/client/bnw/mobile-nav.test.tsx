// Step 7.5-A — focused SSR coverage for the mobile shell nav (bottom tabs + 更多 list).
// i18n foundation slice: nav copy goes through t(), so render under an en I18nContext provider.
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BottomTabs, MoreMenu } from "./mobile-nav";
import type { BnwRoute } from "../router";
import { I18nContext, translate } from "../i18n";

const EN = { lang: "en" as const, t: (k: string, v?: Record<string, string | number>) => translate(k, "en", v) };
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(createElement(I18nContext.Provider, { value: EN }, el));

test("BottomTabs routes 运行态/看板 to the active mesh and toggles 更多", () => {
  const route: BnwRoute = { k: "runtime", mesh: "demo" };
  const html = render(createElement(BottomTabs, { route, tabMesh: "demo", moreOpen: false, onToggleMore: () => {}, onNavigate: () => {} }));
  expect(html).toContain('data-bnw-bottomtabs');
  expect(html).toContain('href="/bnw/mesh/demo"');
  expect(html).toContain('href="/bnw/mesh/demo/board"');
  expect(html).toContain('data-bnw-more-toggle');
  expect(html).toContain('aria-expanded="false"');
  // hidden at lg+ (mobile-only)
  expect(html).toContain('lg:hidden');
  // active surface marks the current tab
  expect(html).toContain('aria-current="page"');
});

test("BottomTabs with no mesh renders inert (no-href) tabs", () => {
  const route: BnwRoute = { k: "harnesses" };
  const html = render(createElement(BottomTabs, { route, tabMesh: undefined, moreOpen: false, onToggleMore: () => {}, onNavigate: () => {} }));
  expect(html).not.toContain('href="/bnw/mesh');
  expect(html).toContain('aria-disabled="true"');
});

test("BottomTabs reflects 更多 open state via aria-expanded", () => {
  const route: BnwRoute = { k: "settings" };
  const html = render(createElement(BottomTabs, { route, tabMesh: "demo", moreOpen: true, onToggleMore: () => {}, onNavigate: () => {} }));
  expect(html).toContain('aria-expanded="true"');
});

test("MoreMenu lists the management routes and shows an unread badge", () => {
  const html = render(createElement(MoreMenu, { onClose: () => {}, unreadCount: 3, onReload: () => {}, reloadDisabled: false, reloading: false }));
  expect(html).toContain('data-bnw-more');
  expect(html).toContain('href="/bnw/assistant"');
  expect(html).toContain('href="/bnw/harnesses"');
  expect(html).toContain('href="/bnw/channels"');
  expect(html).toContain('href="/bnw/doctor"');
  expect(html).toContain('href="/bnw/settings"');
  expect(html).toContain('href="/bnw/notifications"');
  expect(html).toContain('href="/bnw/mesh/new"');
  expect(html).toContain('aria-label="close more"'); // t(bnw.closeMore) @ en
  // #20 — reload mesh definitions lives in 更多 on mobile
  expect(html).toContain('aria-label="reload mesh definitions (mobile)"');
  // unread badge surfaces on the 通知 row
  expect(html).toContain('aria-label="unread notifications"'); // t(bnw.unread) @ en
});

test("MoreMenu hides the unread badge at zero", () => {
  const html = render(createElement(MoreMenu, { onClose: () => {}, unreadCount: 0, onReload: () => {}, reloadDisabled: false, reloading: false }));
  expect(html).not.toContain('aria-label="未读通知"');
});
