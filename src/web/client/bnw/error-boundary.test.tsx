// Step 7.5-C — error boundary contract. The interactive catch + retry/recover path is covered
// by bnw.e2e (real browser); error boundaries don't fire under renderToStaticMarkup, so here we
// assert the pure static reducer + the no-error passthrough.
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BnwErrorBoundary } from "./error-boundary";

test("getDerivedStateFromError captures the thrown error", () => {
  const err = new Error("boom");
  expect(BnwErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err });
});

test("renders children unchanged when there is no error", () => {
  const html = renderToStaticMarkup(
    createElement(BnwErrorBoundary, { resetKey: "/bnw/", children: createElement("div", { "data-x": "child" }, "surface ok") }),
  );
  expect(html).toContain("surface ok");
  expect(html).toContain('data-x="child"');
  expect(html).not.toContain("data-bnw-error-boundary");
});
