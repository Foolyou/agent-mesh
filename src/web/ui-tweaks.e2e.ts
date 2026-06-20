// Browser checks for the input/topology/mesh-list usability tweaks. Run:
//   bun run src/web/ui-tweaks.e2e.ts
import { type Page } from "playwright";
import { authedContext, authedReady, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";

const PORT = Number(process.env.E2E_PORT) || 7460;
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
  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 880 } });
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.mrow:has-text("demo")', { timeout: 8000 });
  await page.locator('.mrow:has-text("demo")').first().click();
  await page.locator('.detail-head .btn:has-text("start mesh")').click();
  await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });

  const routerPanel = ".conv-panel";

  await step("composer is a multi-line <textarea>", async () => {
    await page.waitForSelector(`${routerPanel} .composer textarea`, { timeout: 6000 });
  });

  await step("clicking anywhere in the chat focuses the input", async () => {
    // click the transcript/stream area, NOT the textarea itself
    await page.locator(`${routerPanel} .stream`).click({ position: { x: 20, y: 12 } });
    const ok = await page.locator(`${routerPanel} .composer textarea`).evaluate((el) => el === document.activeElement);
    if (!ok) throw new Error("textarea not focused after chat click");
  });

  await step("Shift+Enter inserts a newline; Enter sends", async () => {
    const ta = page.locator(`${routerPanel} .composer textarea`);
    await ta.focus();
    await ta.type("line one");
    await ta.press("Shift+Enter");
    await ta.type("line two");
    const val = await ta.inputValue();
    if (!val.includes("\n")) throw new Error(`no newline in value: ${JSON.stringify(val)}`);
    await ta.press("Enter");
    await page.waitForSelector(`${routerPanel} .msg.user`, { timeout: 4000 });
    if ((await ta.inputValue()) !== "") throw new Error("textarea not cleared after send");
    const focused = await ta.evaluate((el) => el === document.activeElement);
    if (!focused) throw new Error("textarea not focused after send");
    const align = await page
      .locator(`${routerPanel} .msg.user`)
      .last()
      .evaluate((el) => getComputedStyle(el).textAlign);
    if (align !== "left" && align !== "start") throw new Error(`user message text-align is ${align}`);
  });

  await step("conversation queue preview does not repeat the source label", async () => {
    await page.evaluate(() => {
      (window as any).__meshStore.apply({
        t: "agent.queue",
        name: "demo",
        agent: "router",
        summary: { count: 1, latestPreview: "you: cancel all shortcuts" },
      });
    });
    const box = page.locator(`${routerPanel} .queue-box`);
    await box.waitFor({ timeout: 4000 });
    await box.locator(".queue-source", { hasText: "you" }).waitFor({ timeout: 4000 });
    await box.locator(".queue-preview", { hasText: "cancel all shortcuts" }).waitFor({ timeout: 4000 });
    if (await box.locator(".queue-preview", { hasText: "you:" }).count()) throw new Error("queue preview repeated the source label");
    await page.evaluate(() => {
      (window as any).__meshStore.apply({
        t: "agent.queue",
        name: "demo",
        agent: "router",
        summary: { count: 0 },
      });
    });
    await box.waitFor({ state: "detached", timeout: 4000 });
  });

  await step("global keyboard shortcuts are disabled", async () => {
    await page.locator(".detail-head .mtitle").click();
    await page.keyboard.press("f");
    if (await page.locator(".dmain.full").count()) throw new Error("f key still toggled fullscreen");
    await page.keyboard.press("n");
    if (await page.locator(".modal").count()) throw new Error("n key still opened the new mesh modal");
  });

  await step("topology expand → canvas overlay", async () => {
    const topologyPanel = page.locator(".drail .panel", { has: page.locator('.head .ttl:text-is("topology")') }).first();
    await topologyPanel.locator('.btn[title="expand topology"]').click();
    await page.waitForSelector(".mesh-canvas .canvas-window", { timeout: 4000 });
    await page.locator('.mesh-canvas .canvas-window:has-text("router")').waitFor({ timeout: 4000 });
    await page.locator(".mesh-canvas .canvas-close").click();
    await page.waitForSelector(".mesh-canvas", { state: "detached", timeout: 4000 });
  });

  await step("topology management stays out of the rail header on wide desktop", async () => {
    await page.setViewportSize({ width: 1440, height: 880 });
    const topologyPanel = page.locator(".drail .panel", { has: page.locator('.head .ttl:text-is("topology")') }).first();
    const noHScroll = async () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);

    if (await topologyPanel.locator(".topology-inline-controls .edge-add").isVisible()) {
      throw new Error("topology edit controls are inline in the narrow rail header");
    }
    await topologyPanel.locator('.topology-manage-toggle .btn[aria-label="manage topology"]').click();
    await topologyPanel.locator(".topology-controls.open .edge-add select").first().waitFor({ timeout: 4000 });
    if (!(await noHScroll())) throw new Error("horizontal overflow after opening topology management on wide desktop");
    await topologyPanel.locator('.topology-manage-toggle .btn[aria-label="manage topology"]').click();
    await topologyPanel.locator(".topology-controls.open").waitFor({ state: "detached", timeout: 4000 });
  });

  await step("narrow desktop collapses secondary actions without horizontal overflow", async () => {
    await page.setViewportSize({ width: 900, height: 720 });
    const noHScroll = async () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);

    await page.waitForSelector(".detail-overflow .btn", { timeout: 4000 });
    if (await page.locator('.detail-secondary-actions button:has-text("new sessions")').isVisible()) {
      throw new Error("secondary header action stayed inline at narrow width");
    }
    await page.locator('.detail-overflow .btn[aria-label="actions"]').click();
    await page.waitForSelector('.detail-overflow-menu button:has-text("new sessions")', { timeout: 4000 });

    const topologyPanel = page.locator(".drail .panel", { has: page.locator('.head .ttl:text-is("topology")') }).first();
    if (await topologyPanel.locator(".topology-inline-controls .edge-add").isVisible()) {
      throw new Error("topology edit controls stayed inline at narrow width");
    }
    await topologyPanel.locator('.topology-manage-toggle .btn[aria-label="manage topology"]').click();
    await topologyPanel.locator(".topology-controls.open .edge-add select").first().waitFor({ timeout: 4000 });
    if (!(await noHScroll())) throw new Error("horizontal overflow at 900px detail layout");

    await page.setViewportSize({ width: 1440, height: 880 });
  });

  await step("mesh list caps at 4 with a pager; › goes to the next page", async () => {
    // define enough meshes to exceed one page
    await page.evaluate(async () => {
      const s = (window as any).__meshStore;
      for (let i = 1; i <= 5; i++) {
        await s.defineMesh({ name: `pg-${i}`, agents: [{ id: "router", harness: "claude", project: "p", role: "router" }], edges: [] });
      }
    });
    await page.waitForSelector(".mpage", { timeout: 4000 });
    const rows = await page.locator(".mlist .mrow").count();
    if (rows > 4) throw new Error(`showing ${rows} rows, expected ≤4`);
    const label1 = await page.locator(".mpage .sub").textContent();
    if (!/1 \/ \d/.test(label1 ?? "")) throw new Error(`pager label: ${label1}`);
    const firstPageNames = await page.locator(".mlist .mrow .mname").allTextContents();
    await page.locator('.mpage .btn:has-text("›")').click();
    await sleep(150);
    const secondPageNames = await page.locator(".mlist .mrow .mname").allTextContents();
    if (JSON.stringify(firstPageNames) === JSON.stringify(secondPageNames)) throw new Error("page did not change");
  });

  await step("no console/page errors", async () => {
    if (errors.length) throw new Error(`${errors.length}: ${errors.slice(0, 2).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  UI-TWEAKS E2E OK");
  }
} finally {
  await browser.close();
  server.kill();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
