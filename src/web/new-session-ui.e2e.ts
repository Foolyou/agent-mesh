// Browser e2e for the new-session controls: starts the fake mesh, confirms the
// per-agent and mesh-wide "new session" buttons render, two-click-confirm, and drop a
// "new session" divider into the transcript.
// Run: bun run src/web/new-session-ui.e2e.ts
import { type Page } from "playwright";
import { authedContext, authedReady, launchChromium, provisionE2eAuth } from "./e2e-playwright";
import { rm } from "node:fs/promises";

const PORT = Number(process.env.E2E_PORT) || 7541;
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
  const ctx = await authedContext(browser, auth.token, { viewport: { width: 1440, height: 900 } });
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".mrow.sel", { timeout: 8000 });

  await step("no new-session buttons while the mesh is stopped", async () => {
    if (await page.locator('.conv-control button:has-text("new session")').count()) throw new Error("per-agent button visible before running");
    if (await page.locator('.detail-head button:has-text("new sessions")').count()) throw new Error("mesh button visible before running");
  });

  await step("start mesh", async () => {
    await page.locator('.detail-head .btn:has-text("start mesh")').click();
    await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });
  });

  await step("per-agent new session: two-click confirm drops a divider", async () => {
    const btn = await page.locator('.conv-control button', { hasText: "new session" }).first().elementHandle();
    if (!btn) throw new Error("per-agent new-session button not found");
    await btn.click(); // arm
    await sleep(50);
    await btn.click(); // confirm
    await page.waitForSelector(".session-divider", { timeout: 8000 });
  });

  await step("mesh-wide new sessions: header button confirms and adds another divider", async () => {
    const before = await page.locator(".session-divider").count();
    const btn = await page.locator('.detail-head button', { hasText: "new sessions" }).first().elementHandle();
    if (!btn) throw new Error("mesh-wide new-session button not found");
    await btn.click(); // arm
    await sleep(50);
    await btn.click(); // confirm
    await page.waitForFunction((n) => document.querySelectorAll(".session-divider").length > n, before, { timeout: 8000 });
  });

  await step("no page errors", async () => {
    if (errors.length) throw new Error(`${errors.length}: ${errors.slice(0, 2).join(" || ")}`);
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  NEW-SESSION-UI E2E OK — buttons render, confirm, and drop dividers");
  }
} finally {
  await browser.close();
  server.kill();
  await rm(auth.meshRootBase, { recursive: true, force: true });
}
