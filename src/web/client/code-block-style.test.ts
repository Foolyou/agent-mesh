import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

function blockFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  return match?.[1] ?? "";
}

test("markdown fenced code blocks reset inherited wrapping so code layout is stable", () => {
  const pre = blockFor(".md pre");
  const code = blockFor(".md pre code");

  expect(pre).toContain("overflow-x: auto");
  expect(pre).toContain("white-space: pre");
  expect(pre).toContain("overflow-wrap: normal");
  expect(pre).toContain("word-break: normal");

  expect(code).toContain("white-space: inherit");
  expect(code).toContain("overflow-wrap: inherit");
  expect(code).toContain("word-break: inherit");
});
