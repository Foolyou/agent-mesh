import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

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
