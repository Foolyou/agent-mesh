// Step 6 — Playwright smoke + screenshots for the guarded /__ui-mockup application
// shell mockup. Boots --fake with MESH_UI_PREVIEW=1, then: mounts the guarded route,
// loads a ?device=mobile deep link, performs a view-switch interaction (运行态→看板),
// asserts the live compose() tokens, and captures desktop + mobile (+ one accent
// comparison) frame screenshots (≤1500px wide). Run: `bun run src/web/ui-mockup.e2e.ts`.
import { type Page } from "playwright";
import { launchChromium, provisionE2eAuth, authedReady } from "./e2e-playwright";
import { compose } from "./client/themes";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT) || 7473;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.AGENT_MESH_ARTIFACTS || "/tmp/mesh-mockup-shots";
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

const auth = await provisionE2eAuth({ MESH_UI_PREVIEW: "1" });
const server = Bun.spawn(["bun", "run", "src/main.ts", "run", "--fake", "--port", String(PORT)], { stdout: "pipe", stderr: "pipe", env: auth.env });
const browser = await launchChromium();
const shots: string[] = [];
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await authedReady(BASE, auth.token)).ok) break;
    } catch {}
    await sleep(250);
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  const cssVar = (n: string) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), n);
  const shotFrame = async (file: string) => {
    await page.locator('[data-mockup="frame"]').screenshot({ path: file });
    shots.push(file);
  };

  await step("guarded /__ui-mockup mounts the desktop shell", async () => {
    await page.goto(`${BASE}/__ui-mockup`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="desktop"]', { timeout: 8000 });
    if (await page.locator('[aria-label="meshes"]').count() !== 1) throw new Error("left nav missing");
  });

  await step("?device=mobile deep link renders the mobile shell + bottom tabs", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=mobile`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="mobile"]', { timeout: 8000 });
    if (await page.getByRole("tab").count() !== 3) throw new Error("expected 3 bottom tabs");
    await page.getByRole("tab", { name: "更多" }).click();
    await sleep(80);
    if (await page.getByText("设置 · 主题").count() === 0) throw new Error("更多 sheet did not show management/settings");
  });

  await step("view switch interaction 运行态→看板 swaps the stage", async () => {
    await page.goto(`${BASE}/__ui-mockup`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"]', { timeout: 8000 });
    if (await page.getByText("运行态 视图占位").count() === 0) throw new Error("runtime stage not shown initially");
    await page.locator('[aria-label="View"]').getByRole("radio", { name: "看板" }).click();
    await sleep(120);
    if (await page.getByText("看板 视图占位").count() === 0) throw new Error("board stage not shown after switch");
  });

  await step("live compose() tokens applied to :root (default Dark·Slate × Signal Teal)", async () => {
    const expected = compose("dark-slate", "signal-teal");
    if ((await cssVar("--surface")) !== expected.surface) throw new Error(`--surface=${await cssVar("--surface")}`);
    if ((await cssVar("--accent")) !== expected.accent) throw new Error(`--accent=${await cssVar("--accent")}`);
  });

  await step("screenshot desktop · dark-slate × signal-teal", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&view=runtime&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="desktop"]', { timeout: 8000 });
    await sleep(150);
    await shotFrame(`${SHOTS}/shell-desktop-dark-slate-signal-teal.png`);
  });

  await step("screenshot mobile · dark-slate × signal-teal", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=mobile&view=runtime&mode=dark-slate&accent=signal-teal`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="mobile"]', { timeout: 8000 });
    await sleep(150);
    await shotFrame(`${SHOTS}/shell-mobile-dark-slate-signal-teal.png`);
  });

  await step("screenshot desktop · dark-slate × ember (accent comparison)", async () => {
    await page.goto(`${BASE}/__ui-mockup?device=desktop&view=runtime&mode=dark-slate&accent=ember`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-mockup="frame"][data-device="desktop"]', { timeout: 8000 });
    await sleep(150);
    await shotFrame(`${SHOTS}/shell-desktop-dark-slate-ember.png`);
  });

  await step("no page errors across the mockup", async () => {
    if (errors.length) throw new Error(errors.slice(0, 3).join(" | "));
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(`\nMOCKUP E2E: ${pass} passed, ${fails.length} failed`);
console.log(`screenshots (${shots.length}) → ${SHOTS}`);
if (fails.length) {
  console.log("FAILED:", fails.join("; "));
  process.exit(1);
}
console.log("MOCKUP E2E OK");
