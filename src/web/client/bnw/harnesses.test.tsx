// Step 7.4-A.2a — focused SSR tests for the /bnw Harnesses surface (mockup 06). The stateful
// BnwHarnesses probes via effects (covered by bnw.e2e against a stubbed probe); here we render
// the presentational pieces against HarnessProbeRow fixtures + the loading shell.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { BnwHarnesses, HarnessRow, SelfInstallerGuide, InstallProgressCard, OldVersionAgentsCard } from "./harnesses";
import type { HarnessProbeRow } from "../../types";
import type { Store } from "../store";
import { I18nContext, translate, type TFn } from "../i18n";

// Copy now flows through t(); render under an en I18nContext so assertions read English (the
// default context returns raw keys). The browser e2e covers zh + live switch.
const EN = { lang: "en" as const, t: ((k, vars) => translate(k, "en", vars)) as TFn };
const wrap = (el: ReactElement) => <I18nContext.Provider value={EN}>{el}</I18nContext.Provider>;
const r = (el: ReactElement) => renderToStaticMarkup(wrap(el));

const base = (o: Partial<HarnessProbeRow> & Pick<HarnessProbeRow, "id" | "label">): HarnessProbeRow => ({
  installed: false, auth: "unknown", installable: "npm", lastProbeAt: 0, runningAgentsUsingOldVersion: [], ...o,
});
const CLAUDE = base({ id: "claude", label: "Claude", installed: true, version: "1.4.2", toolVersion: "0.141.0", latest: "1.4.2", outdated: false, auth: "ok" });
const CODEX = base({ id: "codex", label: "Codex", installed: true, version: "1.2.3", toolVersion: "0.140.0", latest: "1.2.5", outdated: true, auth: "required", runningAgentsUsingOldVersion: ["demo/codex-1"] });
const OPENCODE = base({ id: "opencode", label: "OpenCode", installed: false, installable: "self", installHint: { command: "npm i -g opencode", docsUrl: "https://opencode.example/docs" } });
const noop = () => {};

test("HarnessRow ok: dual-version line + installed chip + reprobe, no install button", () => {
  const out = r(<HarnessRow row={CLAUDE} onReprobe={noop} onInstall={noop} />);
  expect(out).toContain("data-harness-row");
  expect(out).toContain("Claude");
  expect(out).toContain("claude-agent-acp 1.4.2 · claude 0.141.0");
  expect(out).toContain("installed v1.4.2");
  expect(out).toContain('aria-label="reprobe claude"');
  expect(out).not.toContain('aria-label="install claude"');
  expect(out).not.toContain('aria-label="update claude"');
});

test("HarnessRow outdated+auth: update button + auth-required chip", () => {
  const out = r(<HarnessRow row={CODEX} onReprobe={noop} onInstall={noop} />);
  expect(out).toContain("update available — v1.2.3 → v1.2.5");
  expect(out).toContain("auth required");
  expect(out).toContain('aria-label="update codex"');
});

test("HarnessRow self-install: guide (copy/docs/reprobe-to-detect), no duplicate top reprobe/install", () => {
  const out = r(<HarnessRow row={OPENCODE} onReprobe={noop} onInstall={noop} />);
  expect(out).toContain("data-self-installer");
  expect(out).toContain("npm i -g opencode");
  expect(out).toContain('aria-label="copy install command for opencode"');
  expect(out).toContain('aria-label="open opencode docs"');
  expect(out).toContain('aria-label="reprobe to detect opencode"');
  expect(out).not.toContain('aria-label="reprobe opencode"'); // self rows: reprobe only inside the guide
  expect(out).not.toContain('aria-label="install opencode"');
});

test("InstallProgressCard states: running(spinner,no close) / done(close) / interrupted(retry+close)", () => {
  const mk = (status: "running" | "done" | "interrupted") => r(<InstallProgressCard install={{ harness: "codex", pkgSpec: "codex-acp@1.2.5", status, liveText: "x", lines: ["line a"] }} onRetry={noop} onClose={noop} />);
  const running = mk("running");
  expect(running).toContain("data-install-progress");
  expect(running).toContain('role="status"'); // spinner
  expect(running).not.toContain('aria-label="close install progress"');
  expect(mk("done")).toContain('aria-label="close install progress"');
  const interrupted = mk("interrupted");
  expect(interrupted).toContain('aria-label="retry stream"');
  expect(interrupted).toContain('aria-label="close install progress"');
});

test("OldVersionAgentsCard: after-idle + force(confirm) controls per agent", () => {
  const agents = [{ harnessId: "codex" as const, target: "1.2.5", entry: "demo/codex-1" }];
  const out = r(<OldVersionAgentsCard agents={agents} store={{} as Store} />);
  expect(out).toContain("data-old-agents");
  expect(out).toContain("demo/codex-1");
  expect(out).toContain("running an older codex → v1.2.5");
  expect(out).toContain('aria-label="restart demo/codex-1 after idle"');
  expect(out).toContain('aria-label="force restart demo/codex-1"');
});

test("SelfInstallerGuide disabled: copy/reprobe disabled", () => {
  const out = r(<SelfInstallerGuide id="kimi" command="npm i -g kimi" docsUrl="https://k" disabled onReprobe={noop} />);
  expect(out).toMatch(/aria-label="copy install command for kimi"[^>]*disabled/);
});

test("BnwHarnesses shell: PanelFrame + refresh; SSR (no effects) shows loading skeleton", () => {
  const STUB = { listHarnesses: async () => [] } as unknown as Store;
  const out = r(<BnwHarnesses store={STUB} />);
  expect(out).toContain('data-harnesses="panel"');
  expect(out).toContain("Harnesses");
  expect(out).toContain('aria-label="refresh harness status"');
  expect(out).toContain("loading status…");
  expect(out).not.toContain("data-harness-row");
});
