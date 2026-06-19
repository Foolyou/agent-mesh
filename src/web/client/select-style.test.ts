import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8").replace(/\r\n?/g, "\n");

function blockFor(selector: string, source = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return match?.[1] ?? "";
}

function exactBlockFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return match?.[1] ?? "";
}

function blocksFor(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "gm")), (m) => m[1]);
}

test("select controls reserve space for the native disclosure arrow", () => {
  const sharedSelect = blockFor(".select-control");
  const mobileTheme = blockFor(".topbar .theme-sel");
  const mobileConversation = blockFor(".conv-control .mode-sel,\n  .conv-control .model-sel,\n  .conv-control .effort-sel");

  expect(sharedSelect).toContain("padding-right: 24px");
  expect(sharedSelect).toContain("text-overflow: ellipsis");
  expect(mobileTheme).toContain("padding-right: 24px");
  expect(mobileConversation).toContain("padding-right: 24px");
  expect(css.indexOf(".select-control {")).toBeGreaterThan(css.indexOf(".theme-sel {"));
  expect(css.indexOf(".select-control {")).toBeGreaterThan(css.indexOf(".mode-sel,"));
});

test("selected mesh row buttons keep a visible selection-colored border", () => {
  const selectedButton = blocksFor(".mrow.sel .btn").join("\n");
  const selectedButtonHover = exactBlockFor(".mrow.sel .btn:hover");

  expect(selectedButton).toContain("color: var(--sel-fg)");
  expect(selectedButton).toContain("border-color: var(--sel-fg)");
  expect(selectedButton).not.toContain("border-color: transparent");
  expect(selectedButtonHover).toContain("border-color: var(--sel-fg)");
});

test("narrow detail layout collapses secondary actions instead of overflowing", () => {
  const responsive = css.slice(css.lastIndexOf("@media (max-width: 1100px)"));
  const detailSecondary = blockFor(".detail-secondary-actions", responsive);
  const detailOverflow = blockFor(".detail-overflow", responsive);
  const conversation = blockFor(".conv-control", responsive);

  expect(detailSecondary).toContain("display: none");
  expect(detailOverflow).toContain("display: inline-flex");
  expect(conversation).toContain("flex-wrap: wrap");
});

test("topology edit controls live in the expandable manage area", () => {
  const inline = blockFor(".topology-inline-controls");
  const toggle = blockFor(".topology-manage-toggle");
  const openControls = blockFor(".topology-controls.open");

  expect(inline).toContain("display: none");
  expect(toggle).toContain("display: inline-flex");
  expect(openControls).toContain("display: flex");
});

test("jump-to-bottom control keeps a touch-sized target clear of scrollbars", () => {
  const button = blockFor(".jump-bottom");
  const hoverMedia = css.slice(css.indexOf("@media (hover: hover)"));

  expect(button).toContain("right: max(20px, calc(env(safe-area-inset-right) + 16px))");
  expect(button).toContain("width: 44px");
  expect(button).toContain("height: 44px");
  expect(button).toContain("box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22)");
  expect(hoverMedia).toContain(".jump-bottom:hover");
});

test("root layout height follows the visual viewport variable", () => {
  const root = blockFor("html,\nbody,\n#root");
  const app = blockFor(".app");
  const fullscreenAssistant = blockFor(".assistant-chat.assistant-full");

  expect(root).toContain("height: var(--mesh-vvh, 100dvh)");
  expect(app).toContain("height: var(--mesh-vvh, 100dvh)");
  expect(fullscreenAssistant).toContain("height: var(--mesh-vvh, 100dvh)");
});

test("mobile pins the app shell to the visual viewport; desktop stays static", () => {
  // The first `max-width: 760px` block is the app-shell layout breakpoint.
  const firstMobile = css.indexOf("@media (max-width: 760px)");
  const nextMedia = css.indexOf("@media", firstMobile + 1);
  const mobile = css.slice(firstMobile, nextMedia);

  // The dedicated `.app` pinning rule inside the mobile scope (the combined
  // selector lists `html, body, #root, .app { ... }` carry width/overflow only).
  const mobileApp =
    (mobile.match(/(?:^|\n)\s*\.app\s*\{[^}]*\}/gm) ?? []).find((block) => /position:\s*fixed/.test(block)) ?? "";

  expect(mobileApp).toContain("position: fixed");
  expect(mobileApp).toContain("top: var(--mesh-vvtop, 0px)");
  expect(mobileApp).toContain("left: 0");
  expect(mobileApp).toContain("right: 0");
  expect(mobileApp).toContain("overflow: hidden");
  // keeps following the dynamic visual-viewport height
  expect(mobileApp).toContain("height: var(--mesh-vvh, 100dvh)");

  // Desktop base layout must NOT inherit any keyboard-pinning behavior.
  const desktopApp = blockFor(".app");
  expect(desktopApp).toContain("height: var(--mesh-vvh, 100dvh)");
  expect(desktopApp).not.toContain("position: fixed");
  expect(desktopApp).not.toContain("--mesh-vvtop");
  const desktopRoot = blockFor("html,\nbody,\n#root");
  expect(desktopRoot).not.toContain("position: fixed");
  expect(desktopRoot).not.toContain("--mesh-vvtop");
});
