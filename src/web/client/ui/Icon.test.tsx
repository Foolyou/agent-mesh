// #6 — Icon primitive contract: currentColor stroke (inherits theme), decorative by default
// (aria-hidden), labelled mode (title → role="img" + <title>).
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "./Icon";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

test("Icon is an inline SVG that inherits color via currentColor", () => {
  const out = html(createElement(Icon, { name: "bell" }));
  expect(out).toContain("<svg");
  expect(out).toContain('stroke="currentColor"');
  expect(out).toContain('fill="none"');
  expect(out).toContain('width="16"'); // default size
});

test("Icon is decorative (aria-hidden) by default", () => {
  const out = html(createElement(Icon, { name: "gear" }));
  expect(out).toContain('aria-hidden="true"');
  expect(out).not.toContain('role="img"');
});

test("Icon with a title is a labelled image (role=img + <title>)", () => {
  const out = html(createElement(Icon, { name: "bell", title: "通知" }));
  expect(out).toContain('role="img"');
  expect(out).toContain("<title>通知</title>");
  expect(out).not.toContain('aria-hidden');
});

test("size prop controls width/height", () => {
  const out = html(createElement(Icon, { name: "search", size: 28 }));
  expect(out).toContain('width="28"');
  expect(out).toContain('height="28"');
});
