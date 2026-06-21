// Step 7.4-B — focused SSR tests for the /bnw Settings surface (mockup 09). Renders each ?tab
// against localStorage-fallback defaults (no effects); the device own-status read + theme apply
// side-effects are covered by bnw.e2e.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BnwSettings } from "./settings";

const render = (tab?: string) => renderToStaticMarkup(<BnwSettings route={{ k: "settings", tab }} />);

test("Settings appearance (default tab): mode/accent + 9-combo live grid + custom palette", () => {
  const out = render();
  expect(out).toContain('data-settings="panel"');
  expect(out).toContain("设置 Settings");
  expect(out).toContain('aria-label="settings tabs"');
  expect(out).toContain("外观 · 主题");
  expect(out).toContain('aria-label="theme mode"');
  expect(out).toContain('aria-label="accent"');
  // 9-combo live preview grid — 9 selectable composition cells
  expect(out).toContain("data-theme-matrix");
  expect((out.match(/data-theme-cell/g) ?? []).length).toBe(9);
  expect(out).toContain('aria-label="apply dark-slate signal-teal"');
  // custom palette editor with real token inputs
  expect(out).toContain("data-custom-palette");
  expect(out).toContain('aria-label="palette bg"');
  expect(out).toContain('aria-label="palette accent"');
  expect(out).toContain('aria-label="reset to composition"');
});

test("Settings ?tab=language: en/zh picker + technical-terms note", () => {
  const out = render("language");
  expect(out).toContain("语言 · language");
  expect(out).toContain('aria-label="language"');
  expect(out).toContain("English");
  expect(out).toContain("两种语言均保留英文");
  expect(out).not.toContain("data-theme-matrix"); // not the appearance tab
});

test("Settings ?tab=prefs: default-view + default-device (client-local, honest)", () => {
  const out = render("prefs");
  expect(out).toContain("偏好 · preferences");
  expect(out).toContain('aria-label="default landing view"');
  expect(out).toContain('aria-label="default device"');
  expect(out).toContain("本机（localStorage，非服务端）"); // explicit: not a server write
});

test("Settings ?tab=devices: own-device status + host-CLI placeholder, NO web approve/revoke", () => {
  const out = render("devices");
  expect(out).toContain("设备授权 · device management");
  expect(out).toContain("data-device-row");
  expect(out).toContain("本设备 · this device");
  expect(out).toContain("data-device-mgmt");
  expect(out).toContain("mesh device list");
  expect(out).toContain("mesh auth bootstrap");
  expect(out).not.toContain("aria-label=\"approve");
  expect(out).not.toContain("aria-label=\"revoke");
});

test("Settings: unknown ?tab falls back to appearance", () => {
  expect(render("bogus")).toContain("外观 · 主题");
});
