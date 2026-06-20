import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { HarnessPanel, HarnessRow, harnessVersionLine } from "./HarnessPanel";
import type { Store } from "./store";
import type { HarnessProbeRow } from "../types";

const probeRow = (over: Partial<HarnessProbeRow>): HarnessProbeRow => ({
  id: "codex",
  label: "Codex",
  installed: true,
  auth: "ok",
  installable: "npm",
  lastProbeAt: 1,
  runningAgentsUsingOldVersion: [],
  ...over,
});

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

test("harnessVersionLine renders compact adapter · body versions with — for unknown", () => {
  // codex/claude: adapter · body; opencode/kimi: single command
  expect(harnessVersionLine(probeRow({ id: "codex", version: "1.2.3", toolVersion: "0.141.0" }))).toBe("codex-acp 1.2.3 · codex 0.141.0");
  expect(harnessVersionLine(probeRow({ id: "claude", label: "Claude", version: "0.44.0", toolVersion: undefined }))).toBe("claude-agent-acp 0.44.0 · claude —");
  expect(harnessVersionLine(probeRow({ id: "codex", version: undefined, toolVersion: undefined }))).toBe("codex-acp — · codex —");
  expect(harnessVersionLine(probeRow({ id: "opencode", label: "OpenCode", version: "0.5.0" }))).toBe("opencode 0.5.0");
});

test("HarnessRow shows the dual-version line for an installed harness and keeps the adapter status badge", () => {
  const html = renderToStaticMarkup(createElement(HarnessRow, {
    row: probeRow({ id: "codex", version: "1.2.3", toolVersion: "0.141.0", latest: "1.5.0", outdated: true, path: "/bin/codex-acp" }),
    onInstall: () => {},
    onReprobe: () => {},
  }));
  expect(html).toContain("harness-versions");
  expect(html).toContain("codex-acp 1.2.3 · codex 0.141.0");
  // adapter outdated status badge is unchanged and still driven by version/latest/outdated
  expect(html).toContain("update available — v1.2.3 → v1.5.0");
});

test("HarnessRow omits the dual-version line when the harness is not installed", () => {
  const html = renderToStaticMarkup(createElement(HarnessRow, {
    row: probeRow({ id: "codex", installed: false, version: undefined, toolVersion: undefined }),
    onInstall: () => {},
    onReprobe: () => {},
  }));
  expect(html).not.toContain("harness-versions");
  expect(html).toContain("missing — install required");
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
