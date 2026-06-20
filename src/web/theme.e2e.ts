// Browser check for the theme system: preset switching, persistence across reload,
// the live custom-theme editor, and a few screenshots. Run: bun run src/web/theme.e2e.ts
import { type Page } from "playwright";
import { authedContext, authedReady, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";

const PORT = Number(process.env.E2E_PORT) || 7440;
const BASE = `http://localhost:${PORT}`;
const SHOTS = "/tmp/mesh-shots";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

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

const auth = await provisionE2eAuth();
const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe", env: auth.env });
const browser = await launchChromium();
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await authedReady(BASE, auth.token)).ok) break;
    } catch {}
    await sleep(250);
  }
  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 860 } });
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".theme-sel", { timeout: 8000 });

  await step("default theme is phosphor", async () => {
    if ((await bg()) !== "#0a0b0d") throw new Error(`bg=${await bg()}`);
  });

  await step("switching to Paper applies a light background", async () => {
    await page.selectOption(".theme-sel", "paper");
    await sleep(150);
    if ((await bg()) !== "#f4f2ec") throw new Error(`bg=${await bg()}`);
    await page.locator('.mrow:has-text("demo")').first().click().catch(() => {});
    await sleep(400);
    await page.screenshot({ path: `${SHOTS}/theme-paper.png` });
  });

  await step("theme persists across reload", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".theme-sel", { timeout: 6000 });
    if ((await bg()) !== "#f4f2ec") throw new Error(`after reload bg=${await bg()}`);
  });

  await step("Amber preset applies", async () => {
    await page.selectOption(".theme-sel", "amber");
    await sleep(150);
    if ((await bg()) !== "#100a04") throw new Error(`bg=${await bg()}`);
    await page.locator('.mrow:has-text("demo")').first().click().catch(() => {});
    await sleep(300);
    await page.screenshot({ path: `${SHOTS}/theme-amber.png` });
  });

  await step("custom editor live-previews and saves a color", async () => {
    await page.locator('.theme-controls .btn:has-text("✎")').click();
    await page.waitForSelector(".modal .theme-grid", { timeout: 4000 });
    // first row is the background ('bg'); set it to a recognizable value
    await page.locator(".theme-grid .theme-row").first().locator(".hex").fill("#123456");
    await sleep(150);
    if ((await bg()) !== "#123456") throw new Error(`live preview bg=${await bg()}`);
    await page.locator('.modal .btn:has-text("save as custom")').click();
    await sleep(150);
    const sel = await page.locator(".theme-sel").inputValue();
    if (sel !== "custom") throw new Error(`select=${sel}`);
  });

  await step("custom theme persists across reload", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".theme-sel", { timeout: 6000 });
    if ((await bg()) !== "#123456") throw new Error(`after reload bg=${await bg()}`);
    if ((await page.locator(".theme-sel").inputValue()) !== "custom") throw new Error("select not custom");
  });

  await step("no console/page errors", async () => {
    if (errors.length) throw new Error(`${errors.length}: ${errors.slice(0, 2).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  THEME E2E OK — screenshots theme-paper.png / theme-amber.png");
  }
} finally {
  await browser.close();
  server.kill();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
