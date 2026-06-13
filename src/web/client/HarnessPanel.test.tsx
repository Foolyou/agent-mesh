import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { HarnessPanel } from "./HarnessPanel";
import type { Store } from "./store";

test("HarnessPanel renders text status labels and accessible install controls", () => {
  const store = {
    subscribe: () => () => {},
    listHarnesses: async () => [],
    installHarness: async () => ({ jobId: "j", status: "running", harnessId: "claude", pkgSpec: "@x/y@1.0.0" }),
    streamHarnessInstall: async () => {},
    reprobeHarness: async () => {},
  } as unknown as Store;
  const html = renderToStaticMarkup(createElement(HarnessPanel, { store, open: true, onClose: () => {} }));
  expect(html).toContain("Harness settings");
  expect(html).toContain("loading status");
  expect(html).toContain('aria-label="Refresh harness status"');
  expect(html).toContain('role="dialog"');
});
