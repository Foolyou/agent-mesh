// Browser checks for i18n (en⇄zh toggle + persistence) and the info-icon density
// pass. Run: bun run src/web/i18n.e2e.ts
import { chromium, type Page } from "playwright";

const PORT = Number(process.env.E2E_PORT) || 7470;
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

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe" });
const browser = await chromium.launch({ headless: true });
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + "/api/state")).ok) break;
    } catch {}
    await sleep(250);
  }
  // force English default regardless of the runner's locale
  const ctx = await browser.newContext({ locale: "en-US" });
  const page: Page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sidebar", { timeout: 8000 });

  await step("default English: the Mesh Assistant panel is labeled", async () => {
    await page.waitForSelector('.sidebar .ttl:has-text("Mesh Assistant")', { timeout: 6000 });
  });

  await step("toggle to 中文 switches the UI", async () => {
    await page.locator('.topbar .btn:has-text("中")').click();
    await page.waitForSelector('.sidebar .ttl:has-text("Mesh 助手")', { timeout: 4000 });
    // a few more strings flipped
    await page.waitForSelector('.btn:has-text("重载")', { timeout: 3000 });
    await page.waitForSelector('.mrow:has-text("已停止"), .mrow:has-text("运行中")', { timeout: 3000 });
  });

  await step("language persists across reload", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('.sidebar .ttl:has-text("Mesh 助手")', { timeout: 5000 });
    await page.waitForSelector('.topbar .btn:has-text("EN")', { timeout: 3000 });
  });

  await step("toggle back to English", async () => {
    await page.locator('.topbar .btn:has-text("EN")').click();
    await page.waitForSelector('.sidebar .ttl:has-text("Mesh Assistant")', { timeout: 4000 });
  });

  await step("density: verbose descriptions are info icons (ⓘ), no hints clutter", async () => {
    const icons = await page.locator(".info-icon").count();
    if (icons < 2) throw new Error(`expected ≥2 info icons, got ${icons}`);
    // the old always-on keyboard-hints span is gone
    if (await page.locator(".stat.hints").count()) throw new Error("verbose hints span still present");
    // the conductor info icon carries the description as a tooltip
    const tip = await page.locator('.sidebar .panel:has(.ttl:has-text("Mesh Assistant")) .info-icon').getAttribute("title");
    if (!tip || tip.length < 10) throw new Error("conductor info icon has no description");
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  I18N + DENSITY E2E OK");
  }
} finally {
  await browser.close();
  server.kill();
}
