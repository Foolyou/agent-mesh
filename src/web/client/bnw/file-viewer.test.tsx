// Step 7.4-A.2b-ii — focused SSR test for the /bnw File/artifact viewer (mockup 11). The
// content states (markdown/code/image/lightbox/error) are effect-driven and covered by bnw.e2e
// against a stubbed fetch; SSR (no effects) renders the loading shell + routing affordances.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { BnwFileViewer } from "./file-viewer";
import { I18nContext, translate, type TFn } from "../i18n";
const EN = { lang: "en" as const, t: ((k, vars) => translate(k, "en", vars)) as TFn };
const r = (el: ReactElement) => renderToStaticMarkup(<I18nContext.Provider value={EN}>{el}</I18nContext.Provider>);

test("BnwFileViewer shell: back link, path, artifact chip, Bearer loading (SSR)", () => {
  const out = r(<BnwFileViewer route={{ k: "file", mesh: "demo", agent: "router", kind: "artifact", path: "reports/gate.md" }} />);
  expect(out).toContain('data-artifact="viewer"');
  expect(out).toContain("data-artifact-back");
  expect(out).toContain('aria-label="back to conversation"');
  expect(out).toContain('href="/bnw/mesh/demo/agent/router"'); // back → runtime focus (the conversation)
  expect(out).toContain("data-artifact-path");
  expect(out).toContain("demo / router / reports/gate.md");
  expect(out).toContain("fetching via Bearer…"); // loading (effects don't run in SSR)
});

test("BnwFileViewer decodes a url-encoded path for display", () => {
  const out = r(<BnwFileViewer route={{ k: "file", mesh: "demo", agent: "codex-1", kind: "file", path: "src%2Fserver.ts" }} />);
  expect(out).toContain("demo / codex-1 / src/server.ts");
});
