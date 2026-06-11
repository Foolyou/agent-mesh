// Mobile-viewport e2e over the --fake server: 390x844 phone, touch enabled. Exercises
// the stack navigation (overview ⇄ detail), the segment switcher, the pinned
// permission cards, and checks there is no horizontal overflow. Run:
//   bun run src/web/mobile.e2e.ts
import { type Page } from "playwright";
import { launchChromium, e2eEnv } from "./e2e-playwright";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT) || 7418;
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
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  const noHScroll = async () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  await step("overview first (mesh list, no auto-detail)", async () => {
    await page.waitForSelector('.mrow:has-text("demo")', { timeout: 8000 });
    if (await page.locator(".mdetail").count()) throw new Error("should start on overview, not detail");
    if (!(await noHScroll())) throw new Error("horizontal overflow on overview");
  });

  await step("theme switcher is visible and usable on mobile", async () => {
    await page.waitForSelector(".theme-sel", { timeout: 4000 });
    const sel = page.locator(".theme-sel");
    if (!(await sel.isVisible())) throw new Error("theme select is hidden");
    const selectStyle = await sel.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { paddingRight: parseFloat(cs.paddingRight), textOverflow: cs.textOverflow };
    });
    if (selectStyle.paddingRight < 24) throw new Error(`theme select right padding too small: ${selectStyle.paddingRight}`);
    if (selectStyle.textOverflow !== "ellipsis") throw new Error(`theme select text-overflow=${selectStyle.textOverflow}`);
    await sel.selectOption("paper");
    await sleep(150);
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    if (bg !== "#f4f2ec") throw new Error(`theme did not apply, bg=${bg}`);
    if (!(await noHScroll())) throw new Error("horizontal overflow after showing theme switcher");
  });

  await page.screenshot({ path: `${SHOTS}/m-01-overview.png` });

  await step("tap a mesh → detail screen with back button", async () => {
    await page.locator('.mrow:has-text("demo")').click();
    await page.waitForSelector(".mdetail", { timeout: 6000 });
    await page.waitForSelector('.topbar .btn:has-text("back")', { timeout: 4000 });
    await page.waitForSelector(".mtabs", { timeout: 4000 });
    const startStrategy = page.locator(".start-session-sel");
    await startStrategy.waitFor({ timeout: 4000 });
    await startStrategy.selectOption("fresh");
    if ((await startStrategy.inputValue()) !== "fresh") throw new Error("fresh start strategy was not selectable");
    if (!(await noHScroll())) throw new Error("horizontal overflow on detail");
  });

  await step("start mesh from detail header", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });
  });

  await step("Chat segment shows conversation tabs + composer", async () => {
    await page.waitForSelector(".mseg .conv-panel .composer textarea", { timeout: 6000 });
  });

  await step("Map segment shows the topology", async () => {
    await page.locator('.mtab:has-text("Map")').click();
    await page.waitForSelector(".mseg .topo svg .node", { timeout: 4000 });
    const box = await page.locator(".mseg .topo svg").boundingBox();
    if (!box || box.height < 100) throw new Error("topology too short on mobile");
  });

  await step("Chat segment switches to a member tab; no separate Agents segment", async () => {
    const labels = await page.locator(".mtabs .mtab").allTextContents();
    if (labels.some((x) => /agents/i.test(x))) throw new Error(`unexpected Agents segment: ${labels.join(",")}`);
    await page.locator('.mtab:has-text("Chat")').click();
    await page.locator('.mseg .conv-member-tab:has-text("codex-1")').click();
    await page.waitForSelector('.mseg .composer textarea[placeholder*="codex-1"]', { timeout: 4000 });
  });

  await step("permission card is pinned above the segments and resolves", async () => {
    await page.waitForSelector(".mperm .perm", { timeout: 12000 });
    await page.screenshot({ path: `${SHOTS}/m-02-permission.png` });
    await page.locator('.mperm .perm .btn:has-text("Allow once")').click();
    await page.waitForSelector(".mperm .perm", { state: "detached", timeout: 6000 });
  });

  await step("Log segment shows activity + mailbox", async () => {
    await page.locator('.mtab:has-text("Log")').click();
    await page.waitForSelector('.mseg .mlog .panel:has(.head:has-text("activity"))', { timeout: 4000 });
    await page.waitForSelector('.mseg .mlog .panel:has(.head:has-text("mailbox")) .k.mail', { timeout: 8000 });
  });

  await page.screenshot({ path: `${SHOTS}/m-03-detail.png` });

  await step("back returns to overview", async () => {
    await page.locator('.topbar .btn:has-text("back")').click();
    await page.waitForSelector('.mrow:has-text("demo")', { timeout: 4000 });
    if (await page.locator(".mdetail").count()) throw new Error("still on detail after back");
  });

  await step("no console/page errors", async () => {
    if (errors.length) throw new Error(`${errors.length} errors: ${errors.slice(0, 3).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  MOBILE E2E OK — screenshots in /tmp/mesh-shots (m-*.png)");
  }
} finally {
  await browser.close();
  server.kill();
}
