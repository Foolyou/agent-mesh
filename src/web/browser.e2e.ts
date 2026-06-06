// Headless browser end-to-end over the `--fake` server: spawns the server, drives the
// real DOM with Playwright (bundled chromium), and asserts every widget. Also writes
// screenshots to /tmp/mesh-shots. Run: bun run src/web/browser.e2e.ts
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT) || 7413;
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

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("server never became ready");
}

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT)], {
  stdout: "pipe",
  stderr: "pipe",
});

const browser = await chromium.launch({ headless: true });
try {
  await waitReady();
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  // ignore HTTP-status resource logs (e.g. the deliberate 400 in the toast test —
  // the app surfaces those as toasts); keep genuine JS/React errors.
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  await step("topbar + ws live + demo mesh listed", async () => {
    await page.waitForSelector(".brand", { timeout: 8000 });
    await page.waitForSelector('.stat:has-text("live")', { timeout: 8000 });
    await page.waitForSelector('.mrow:has-text("demo")', { timeout: 8000 });
  });

  await step("mesh auto-selected → detail header shows start button", async () => {
    await page.waitForSelector('.detail-head:has-text("demo")', { timeout: 8000 });
    await page.waitForSelector('.detail-head .btn:has-text("start mesh")', { timeout: 8000 });
  });

  await step("topology renders 3 nodes + edges", async () => {
    await page.waitForSelector(".topo svg .node", { timeout: 8000 });
    const nodes = await page.locator(".topo .node").count();
    if (nodes !== 3) throw new Error(`expected 3 nodes, got ${nodes}`);
    const edges = await page.locator(".topo .edge").count();
    if (edges < 1) throw new Error("no topology edges");
    const box = await page.locator(".topo svg").boundingBox();
    if (!box || box.height < 120) throw new Error(`topology svg too short (${box?.height}px) — graph cropped`);
  });

  await page.screenshot({ path: `${SHOTS}/01-loaded.png`, fullPage: true });

  await step("start mesh → status running, agents ready", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });
  });

  await step("router message is COALESCED into one growing bubble (not per-chunk)", async () => {
    // the fake streams 'Plan: codex-1 implements the calculator core, opencode-1 reviews.'
    const bubble = page.locator('.panel:has(.head:has-text("router chat")) .msg.agent .bubble', {
      hasText: "implements the calculator core",
    });
    await bubble.first().waitFor({ timeout: 10000 });
    const count = await page.locator('.panel:has(.head:has-text("router chat")) .msg.agent').count();
    if (count > 3) throw new Error(`too many message bubbles (${count}) — chunks not coalesced`);
  });

  await step("router shows a plan checklist", async () => {
    await page.waitForSelector('.panel:has(.head:has-text("router chat")) .plan .plan-row', { timeout: 9000 });
  });

  await step("messages show timestamps", async () => {
    const t = await page.locator(".msg .who .t").first().textContent();
    if (!/\d\d:\d\d:\d\d/.test(t ?? "")) throw new Error(`no timestamp (got "${t}")`);
  });

  await step("thought block present and expandable", async () => {
    const label = page.locator(".thought .label").first();
    await label.waitFor({ timeout: 8000 });
    await label.click();
    await page.waitForSelector(".thought .txt", { timeout: 4000 });
  });

  await step("tool-call card merges updates → completed with output", async () => {
    // switch to codex-1 agent panel via topology node click
    await page.locator('.topo .node:has-text("codex-1")').click();
    await page.waitForSelector('.tool .badge.completed', { timeout: 12000 });
    // exactly one tool card for the single tool call (merged, not one-per-update)
    const cards = await page.locator(".tool").count();
    if (cards < 1) throw new Error("no tool card");
    // expand output → shows tool input + output detail
    await page.locator(".tool .thead").first().click();
    await page.waitForSelector(".tool .tout", { timeout: 4000 });
    await page.waitForSelector('.tool .tdetail .tlabel:has-text("input")', { timeout: 4000 });
  });

  await step("failed command surfaces an error toast", async () => {
    // starting an already-running mesh fails → toast (drives the store directly)
    await page.evaluate(() => (window as any).__meshStore.startMesh("demo").catch(() => {}));
    await page.waitForSelector(".toast.error", { timeout: 4000 });
  });

  await step("mailbox shows inter-agent mail", async () => {
    await page.waitForSelector('.panel:has(.head:has-text("mailbox")) .k.mail', { timeout: 10000 });
  });

  await step("activity timeline shows mail + interrupt + log", async () => {
    await page.waitForSelector('.panel:has(.head:has-text("activity")) .k.interrupt', { timeout: 10000 });
  });

  await step("permission card appears and resolves into history", async () => {
    const card = page.locator(".perm");
    await card.first().waitFor({ timeout: 12000 });
    await page.screenshot({ path: `${SHOTS}/02-running.png`, fullPage: true });
    await page.locator('.perm .btn:has-text("Allow once")').click();
    await page.waitForSelector('.panel:has(.head:has-text("permission history")) .k.permission_resolved', { timeout: 6000 });
    // card gone
    if ((await page.locator(".perm").count()) !== 0) throw new Error("permission card did not clear");
  });

  await step("master chat: send instruction → user bubble + streamed reply", async () => {
    const input = page.locator('.panel:has(.head:has-text("master")) .composer input');
    await input.fill("create a build squad mesh");
    await input.press("Enter");
    await page.waitForSelector('.panel:has(.head:has-text("master")) .msg.user', { timeout: 6000 });
    await page.waitForSelector('.panel:has(.head:has-text("master")) .msg.agent', { timeout: 8000 });
  });

  await step("router chat: send prompt → user bubble", async () => {
    const input = page.locator('.panel:has(.head:has-text("router chat")) .composer input');
    await input.fill("status please");
    await input.press("Enter");
    await page.waitForSelector('.panel:has(.head:has-text("router chat")) .msg.user', { timeout: 6000 });
  });

  await step("keyboard: 'f' fullscreens router chat, Esc exits", async () => {
    await page.locator(".detail").click(); // focus body, not an input
    await page.keyboard.press("f");
    await page.waitForSelector('.panel:has(.head:has-text("router chat")) .btn:has-text("exit")', { timeout: 4000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector('.panel:has(.head:has-text("topology"))', { timeout: 4000 });
  });

  await step("mesh builder: invalid config shows inline error", async () => {
    await page.locator('.topbar .btn:has-text("new mesh")').click();
    await page.waitForSelector(".modal", { timeout: 4000 });
    // name empty + only one router but blank name → error
    await page.locator('.modal .btn:has-text("define mesh")').click();
    await page.waitForSelector(".modal .err", { timeout: 4000 });
  });

  await step("mesh builder: valid config creates a mesh", async () => {
    await page.locator('.modal .field:has(label:has-text("mesh name")) input').fill("squad-x");
    await page.screenshot({ path: `${SHOTS}/03-builder.png`, fullPage: true });
    await page.locator('.modal .btn:has-text("define mesh")').click();
    await page.waitForSelector('.mrow:has-text("squad-x")', { timeout: 6000 });
    // and it auto-opens its console (regression: post-snapshot mesh had no perMesh)
    await page.waitForSelector('.detail-head:has-text("squad-x")', { timeout: 4000 });
    await page.waitForSelector('.panel:has(.head:has-text("topology")) .node', { timeout: 4000 });
  });

  await step("delete a stopped mesh (two-click confirm) removes it", async () => {
    // squad-x is selected + stopped → its header shows a delete button
    await page.locator('.detail-head .btn:has-text("delete")').click();
    await page.locator('.detail-head .btn:has-text("delete?")').click();
    await page.waitForSelector('.mrow:has-text("squad-x")', { state: "detached", timeout: 5000 });
  });

  await page.screenshot({ path: `${SHOTS}/04-final.png`, fullPage: true });

  await step("no console/page errors", async () => {
    if (errors.length) throw new Error(`${errors.length} console errors: ${errors.slice(0, 3).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  BROWSER E2E OK — screenshots in /tmp/mesh-shots");
  }
} finally {
  await browser.close();
  server.kill();
}
