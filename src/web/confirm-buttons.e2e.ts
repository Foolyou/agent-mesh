// Browser check for destructive/high-impact buttons that require a second click.
// Run:
//   bun run src/web/confirm-buttons.e2e.ts
import { type Page } from "playwright";
import { launchChromium, e2eEnv } from "./e2e-playwright";

const PORT = Number(process.env.E2E_PORT) || 7462;
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

async function expectNoCallsAfterClick(page: Page, selector: string, count: () => number) {
  const before = count();
  await page.locator(selector).first().click();
  await sleep(150);
  if (count() !== before) throw new Error(`${selector} called API on first click`);
}

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], {
  stdout: "pipe",
  stderr: "pipe",
  env: e2eEnv(),
});
const browser = await launchChromium();

try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + "/api/state")).ok) break;
    } catch {}
    await sleep(250);
  }

  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 880 } });
  let reloadCalls = 0;
  let stopCalls = 0;

  await page.route("**/api/meshes/reload", async (route) => {
    reloadCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/meshes/demo/stop", async (route) => {
    stopCalls++;
    await route.continue();
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.mrow:has-text("demo")', { timeout: 8000 });

  await step("topbar reload requires a second click", async () => {
    await expectNoCallsAfterClick(page, '.topbar .btn:has-text("reload")', () => reloadCalls);
    await page.waitForSelector('.topbar .btn:has-text("reload?")', { timeout: 1000 });
    await page.locator('.topbar .btn:has-text("reload?")').click();
    await sleep(150);
    if (reloadCalls !== 1) throw new Error(`reload calls after confirm: ${reloadCalls}`);
  });

  await step("sidebar reload requires a second click", async () => {
    await expectNoCallsAfterClick(page, '.sidebar .head .btn[title="reload"]', () => reloadCalls);
    await page.waitForSelector('.sidebar .head .btn:has-text("reload?")', { timeout: 1000 });
    await page.locator('.sidebar .head .btn:has-text("reload?")').click();
    await sleep(150);
    if (reloadCalls !== 2) throw new Error(`reload calls after sidebar confirm: ${reloadCalls}`);
  });

  await page.locator('.mrow:has-text("demo")').first().click();
  await page.locator('.detail-head .btn:has-text("start mesh")').click();
  await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });

  await step("detail stop requires a second click", async () => {
    await expectNoCallsAfterClick(page, '.detail-head .btn:has-text("stop mesh")', () => stopCalls);
    await page.waitForSelector('.detail-head .btn:has-text("stop?")', { timeout: 1000 });
    await page.locator('.detail-head .btn:has-text("stop?")').click();
    await sleep(150);
    if (stopCalls !== 1) throw new Error(`stop calls after confirm: ${stopCalls}`);
  });

  await page.locator('.detail-head .btn:has-text("start mesh")').click();
  await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });

  await step("mesh-list stop requires a second click", async () => {
    await expectNoCallsAfterClick(page, '.mrow:has-text("demo") .btn:has-text("stop")', () => stopCalls);
    await page.waitForSelector('.mrow:has-text("demo") .btn:has-text("stop?")', { timeout: 1000 });
    await page.locator('.mrow:has-text("demo") .btn:has-text("stop?")').click();
    await sleep(150);
    if (stopCalls !== 2) throw new Error(`stop calls after row confirm: ${stopCalls}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  CONFIRM BUTTONS E2E OK");
  }
} finally {
  await browser.close();
  server.kill();
}
