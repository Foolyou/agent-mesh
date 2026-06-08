// Browser checks for the input/topology/mesh-list usability tweaks. Run:
//   bun run src/web/ui-tweaks.e2e.ts
import { chromium, type Page } from "playwright";

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

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe" });
const browser = await chromium.launch({ headless: true });
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + "/api/state")).ok) break;
    } catch {}
    await sleep(250);
  }
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 880 } });
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
    const align = await page
      .locator(`${routerPanel} .msg.user`)
      .last()
      .evaluate((el) => getComputedStyle(el).textAlign);
    if (align !== "left" && align !== "start") throw new Error(`user message text-align is ${align}`);
  });

  await step("topology expand → modal with zoom controls", async () => {
    await page.locator('.panel:has(.head:has-text("topology")) .btn:has-text("⤢")').first().click();
    await page.waitForSelector(".topo-modal .topo svg .node", { timeout: 4000 });
    const before = await page.locator(".topo-modal .mhead .sub").first().textContent();
    await page.locator('.topo-modal .mhead .btn:has-text("+")').click();
    const after = await page.locator(".topo-modal .mhead .sub").first().textContent();
    if (before === after) throw new Error(`zoom % did not change (${before})`);
    await page.locator('.topo-modal .mhead .btn:has-text("esc")').click();
    await page.waitForSelector(".topo-modal", { state: "detached", timeout: 4000 });
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
}
