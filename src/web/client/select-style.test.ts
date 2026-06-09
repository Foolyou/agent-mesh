import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

function blockFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return match?.[1] ?? "";
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
