// Harness UI e2e: install progress, CSRF guard, registry-unavailable state,
// stale running-agent prompt, respawn clearing, and self-installer guidance.
// Run: bun run src/web/harness-ui.e2e.ts
import { type Page } from "playwright";
import { launchChromium, e2eEnv } from "./e2e-playwright";

const PORT = Number(process.env.E2E_PORT) || 15082;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
const fails: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    fails.push(name);
    console.log(`  ✗ ${name} — ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/api/state`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("server never became ready");
}

type HarnessFixture = {
  id: string;
  label: string;
  installed: boolean;
  version?: string;
  latest?: string;
  outdated?: boolean;
  error?: string;
  auth: string;
  installable: string;
  installHint?: { command: string; docsUrl: string };
  lastProbeAt: number;
  runningAgentsUsingOldVersion: string[];
};

const harnessRows: HarnessFixture[] = [
  {
    id: "claude",
    label: "Claude",
    installed: true,
    version: "0.42.0",
    latest: "0.44.0",
    outdated: true,
    auth: "ok",
    installable: "npm",
    lastProbeAt: 1,
    runningAgentsUsingOldVersion: ["demo/router"],
  },
  {
    id: "codex",
    label: "Codex",
    installed: true,
    version: "0.16.0",
    latest: "0.16.0",
    outdated: false,
    auth: "ok",
    installable: "npm",
    lastProbeAt: 1,
    runningAgentsUsingOldVersion: [],
  },
  {
    id: "opencode",
    label: "OpenCode",
    installed: false,
    auth: "unknown",
    installable: "self",
    installHint: { command: "curl -fsSL https://opencode.ai/install | bash", docsUrl: "https://opencode.ai/docs/" },
    lastProbeAt: 1,
    runningAgentsUsingOldVersion: [],
  },
  {
    id: "kimi",
    label: "Kimi",
    installed: true,
    version: "0.1.0",
    error: "registry-unavailable",
    auth: "required",
    installable: "self",
    lastProbeAt: 1,
    runningAgentsUsingOldVersion: [],
  },
];

function claudeRow() {
  const row = harnessRows.find((r) => r.id === "claude");
  if (!row) throw new Error("missing claude fixture");
  return row;
}

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], {
  stdout: "pipe",
  stderr: "pipe",
  env: e2eEnv(),
});
const browser = await launchChromium();

try {
  await waitReady();
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.route("**/api/harnesses", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(harnessRows) }));
  await page.route("**/api/harnesses/claude/install", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-1", status: "running", harnessId: "claude", pkgSpec: "@agentclientprotocol/claude-agent-acp@0.44.0" }) }),
  );
  await page.route("**/api/harnesses/claude/install/job-1/stream", (route) => {
    const row = claudeRow();
    row.installed = true;
    row.version = "0.44.0";
    row.latest = "0.44.0";
    row.outdated = false;
    row.runningAgentsUsingOldVersion = ["demo/router"];
    return route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body:
        JSON.stringify({ step: "started", harnessId: "claude", pkgSpec: "@agentclientprotocol/claude-agent-acp@0.44.0" }) +
        "\n" +
        JSON.stringify({ step: "install", harnessId: "claude", pkgSpec: "@agentclientprotocol/claude-agent-acp@0.44.0", progress: 55, stdoutLine: "using ~/x.log" }) +
        "\n" +
        JSON.stringify({ step: "done", harnessId: "claude", pkgSpec: "@agentclientprotocol/claude-agent-acp@0.44.0", installedVersion: "0.44.0" }) +
        "\n",
    });
  });
  await page.route("**/api/harnesses/*/reprobe", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
  await page.route("**/api/meshes/demo/agents/router/respawn", (route) => {
    const body = route.request().postDataJSON() as { mode?: string };
    if (body.mode === "force") {
      claudeRow().runningAgentsUsingOldVersion = [];
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: body.mode, scheduled: body.mode === "after-idle", respawned: body.mode === "force" }) });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".brand", { timeout: 8000 });

  await step("install flow streams live progress and marks claude installed", async () => {
    await page.locator('button:has-text("Harnesses")').click();
    await page.waitForSelector('.harness-modal:has-text("Claude")', { timeout: 5000 });
    await page.locator('.harness-row:has-text("Claude") .btn:has-text("update")').click();
    await page.waitForSelector('.install-progress [aria-live="polite"]:has-text("Installed v0.44.0")', { timeout: 5000 });
    if (!(await page.locator(".install-log", { hasText: "~/x.log" }).count())) throw new Error("redacted install log missing");
    await page.locator('.harness-modal .mhead .btn:has-text("refresh")').click();
    await page.waitForSelector('.harness-row:has-text("Claude") .harness-badge.ok:has-text("installed v0.44.0")', { timeout: 5000 });
  });

  await step("cross-origin harness install POST is rejected by CSRF guard", async () => {
    const res = await fetch(`${BASE}/api/harnesses/claude/install`, { method: "POST", headers: { Origin: "https://evil.com" } });
    if (res.status !== 403) throw new Error(`expected 403, got ${res.status}: ${await res.text()}`);
  });

  await step("registry unavailable shows latest comparison unavailable while install remains enabled", async () => {
    await page.waitForSelector('.harness-row:has-text("Kimi") .harness-badge.off:has-text("version comparison unavailable")', { timeout: 5000 });
    const claudeInstall = page.locator('.harness-row:has-text("Claude") .btn:has-text("update"), .harness-row:has-text("Claude") .btn:has-text("install")').first();
    if ((await claudeInstall.count()) !== 1) throw new Error("claude npm install action missing");
    if (await claudeInstall.isDisabled()) throw new Error("npm install action disabled after registry-unavailable row");
  });

  await step("stale agent prompt shows running and newer installed versions with restart action", async () => {
    await page.locator('.harness-modal .mhead .btn:has-text("close")').click();
    await page.locator('.mrow:has-text("demo")').first().click().catch(() => {});
    await page.evaluate(() => (window as any).__meshStore.apply({ t: "harnesses-changed" }));
    await page.waitForSelector('.stale-harness-note:has-text("running claude v0.44.0")', { timeout: 6000 });
    await page.waitForSelector('.stale-harness-note:has-text("newer v0.44.0 installed")', { timeout: 6000 });
    await page.waitForSelector('.stale-harness-note .btn:has-text("Restart agent")', { timeout: 5000 });
  });

  await step("force respawn clears stale prompt after reprobe refresh", async () => {
    await page.locator('.stale-harness-note .btn:has-text("force")').click();
    await page.waitForSelector('.stale-harness-note .btn:has-text("Force restart agent will lose current ACP session context")', { timeout: 5000 });
    await page.locator('.stale-harness-note .btn:has-text("Force restart agent will lose current ACP session context")').click();
    await page.evaluate(() => (window as any).__meshStore.apply({ t: "harnesses-changed" }));
    await page.locator(".stale-harness-note").waitFor({ state: "detached", timeout: 5000 });
  });

  await step("self-installer shows copyable plain command, docs, reprobe, and no install button", async () => {
    await page.locator('button:has-text("Harnesses")').click();
    const row = page.locator('.harness-row:has-text("OpenCode")');
    await row.waitFor({ timeout: 5000 });
    await row.locator('button[aria-label="Copy install command for opencode"]:has-text("copy command")').waitFor({ timeout: 5000 });
    await row.locator('a[aria-label="Open official installation docs for opencode"][href="https://opencode.ai/docs/"]').waitFor({ timeout: 5000 });
    await row.locator('button:has-text("Done? Reprobe to detect")').waitFor({ timeout: 5000 });
    const code = row.locator("pre code", { hasText: "curl -fsSL https://opencode.ai/install | bash" });
    await code.waitFor({ timeout: 5000 });
    if ((await code.locator("a").count()) !== 0) throw new Error("self-installer command was linkified");
    if ((await row.locator('.btn:has-text("install")').count()) !== 0) throw new Error("self-installer install button should not exist");
  });

  await step("no console/page errors", async () => {
    if (errors.length) throw new Error(errors.slice(0, 2).join(" || "));
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  HARNESS UI E2E OK");
  }
} finally {
  await browser.close();
  server.kill();
}
