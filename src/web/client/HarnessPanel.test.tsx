import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { HarnessPanel, HarnessRow } from "./HarnessPanel";
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

test("HarnessPanel renders self-installer commands as copyable text without install buttons", () => {
  const html = renderToStaticMarkup(createElement(HarnessRow, {
    row: {
      id: "opencode",
      label: "OpenCode",
      installed: false,
      auth: "unknown",
      installable: "self",
      installHint: { command: "curl -fsSL https://opencode.ai/install | bash", docsUrl: "https://opencode.ai/docs/" },
      lastProbeAt: 1,
      runningAgentsUsingOldVersion: [],
    },
    onInstall: () => {
      throw new Error("self installers must not be clickable installs");
    },
    onReprobe: () => {},
  }));
  expect(html).toContain("<pre");
  expect(html).toContain("<code>curl -fsSL https://opencode.ai/install | bash</code>");
  expect(html).toContain('aria-label="Copy install command for opencode"');
  expect(html).toContain('aria-label="Open official installation docs for opencode"');
  expect(html).toContain("Done? Reprobe to detect");
  expect(html).not.toContain(">install</button>");
});
