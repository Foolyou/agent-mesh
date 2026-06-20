// Step 5 C8 — Playwright smoke + screenshots for the guarded /__ui-preview gallery.
// Boots the --fake server with MESH_UI_PREVIEW=1, then:
//   1. loads a query deep link (?mode&accent&section) and asserts the section filter
//      + the live compose() tokens applied to :root,
//   2. performs a 9-state switch INTERACTION (clicking the accent/mode SegmentedControl)
//      and asserts the runtime recolors,
//   3. captures all 9 mode×accent full-gallery screenshots (width 1400 ≤ 1500px).
// Run: MESH_UI_PREVIEW=1 is set internally — `bun run src/web/ui-gallery.e2e.ts`.
import { type Page } from "playwright";
import { launchChromium, provisionE2eAuth, authedReady } from "./e2e-playwright";
import { MODES, ACCENTS, compose } from "./client/themes";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT) || 7461;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.AGENT_MESH_ARTIFACTS || "/tmp/mesh-gallery-shots";
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
  // The gallery never touches /api or the WS, so no device token is needed in the browser.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page: Page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  const cssVar = (n: string) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), n);

  // 0) the route is guarded — but enabled here; the gallery root mounts.
  await step("gallery mounts at the guarded /__ui-preview route", async () => {
    await page.goto(`${BASE}/__ui-preview`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-gallery="root"]', { timeout: 8000 });
  });

  // 1) query deep link: section filter + live compose() tokens.
  await step("deep link ?mode=light-cool&accent=ember&section=buttons filters + applies tokens", async () => {
    await page.goto(`${BASE}/__ui-preview?mode=light-cool&accent=ember&section=buttons`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-section="buttons"]', { timeout: 8000 });
    if (await page.locator('[data-section="approval"]').count() !== 0) throw new Error("section filter did not hide other sections");
    const expected = compose("light-cool", "ember");
    const surface = await cssVar("--surface");
    const accent = await cssVar("--accent");
    if (surface !== expected.surface) throw new Error(`--surface=${surface} expected ${expected.surface}`);
    if (accent !== expected.accent) throw new Error(`--accent=${accent} expected ${expected.accent}`);
  });

  // 2) 9-state switch INTERACTION: click the accent + mode SegmentedControls.
  await step("clicking the accent/mode segmented controls recolors the runtime", async () => {
    await page.goto(`${BASE}/__ui-preview`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-gallery="root"]', { timeout: 8000 });
    const before = await cssVar("--accent");
    if (before !== compose("dark-slate", "signal-teal").accent) throw new Error(`default --accent=${before}`);
    await page.locator('[aria-label="Accent"]').getByRole("radio", { name: "Ember" }).click();
    await sleep(120);
    const afterAccent = await cssVar("--accent");
    if (afterAccent !== compose("dark-slate", "ember").accent) throw new Error(`after accent switch --accent=${afterAccent}`);
    await page.locator('[aria-label="Background mode"]').getByRole("radio", { name: "Light·Cool" }).click();
    await sleep(120);
    const afterMode = await cssVar("--surface");
    if (afterMode !== compose("light-cool", "ember").surface) throw new Error(`after mode switch --surface=${afterMode}`);
  });

  // 3) all 9 mode×accent full-gallery screenshots.
  for (const mode of MODES) {
    for (const accent of ACCENTS) {
      await step(`screenshot ${mode} × ${accent}`, async () => {
        await page.goto(`${BASE}/__ui-preview?mode=${mode}&accent=${accent}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-gallery="root"]', { timeout: 8000 });
        await sleep(150); // let compose() settle
        const file = `${SHOTS}/gallery-${mode}-${accent}.png`;
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);
      });
    }
  }

  await step("no page errors across the gallery", async () => {
    if (errors.length) throw new Error(errors.slice(0, 3).join(" | "));
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(`\nGALLERY E2E: ${pass} passed, ${fails.length} failed`);
console.log(`screenshots (${shots.length}) → ${SHOTS}`);
if (fails.length) {
  console.log("FAILED:", fails.join("; "));
  process.exit(1);
}
console.log("GALLERY E2E OK");
