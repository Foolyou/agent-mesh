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

  // Drive window.visualViewport the way iOS Safari does when the soft keyboard
  // opens/closes: shrink height and (when the page scrolls under the keyboard)
  // shift offsetTop. We override the native getters and fire the matching event,
  // then let the installed rAF-coalesced handler flush --mesh-vvh/--mesh-vvtop.
  const origVvHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
  async function driveVisualViewport(height: number, offsetTop: number, fire: "resize" | "scroll") {
    await page.evaluate(
      ({ height, offsetTop, fire }) => {
        const vv = window.visualViewport;
        if (!vv) throw new Error("no visualViewport in this browser");
        Object.defineProperty(vv, "height", { configurable: true, get: () => height });
        Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => offsetTop });
        vv.dispatchEvent(new Event(fire));
      },
      { height, offsetTop, fire },
    );
    // two frames so the coalesced update() definitely flushes the CSS vars
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  }
  const readVv = () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { top: cs.getPropertyValue("--mesh-vvtop").trim(), h: cs.getPropertyValue("--mesh-vvh").trim() };
    });
  const boxOf = async (sel: string) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} has no box (not visible)`);
    return b;
  };

  await step("visualViewport shrink + scroll keeps the mobile shell pinned (no collapse)", async () => {
    // keyboard up: viewport shrinks AND the page scrolls so offsetTop > 0
    await driveVisualViewport(500, 40, "scroll");
    const up = await readVv();
    if (up.h !== "500px") throw new Error(`--mesh-vvh did not shrink: ${up.h}`);
    if (up.top !== "40px") throw new Error(`--mesh-vvtop did not follow offsetTop: ${up.top}`);

    const app = await boxOf(".app");
    // app shell is pinned to the visual viewport: top == offsetTop, height == vvh
    if (Math.abs(app.y - 40) > 1) throw new Error(`app not pinned to offsetTop=40: y=${app.y}`);
    if (Math.abs(app.height - 500) > 1) throw new Error(`app height not vvh=500: h=${app.height}`);

    const visTop = app.y;
    const visBottom = app.y + app.height; // bottom edge of the visible visual viewport
    // no collapse-at-top: the topbar hugs the shell top, not pushed down by a big gap
    const topbar = await boxOf(".topbar");
    if (topbar.y - visTop > 2) throw new Error(`top gap above topbar: ${topbar.y - visTop}px`);

    // topbar, chat segment, mtabs and composer all stay inside the visible band
    for (const sel of [".topbar", ".mseg", ".mtabs", ".mseg .composer"]) {
      const b = await boxOf(sel);
      if (b.y >= visBottom || b.y + b.height <= visTop) throw new Error(`${sel} outside the visible viewport`);
    }
    // the composer must not run past the bottom of the visual viewport (off-screen behind the keyboard)
    const composer = await boxOf(".mseg .composer");
    if (composer.y + composer.height > visBottom + 1)
      throw new Error(`composer runs out of viewport: bottom=${composer.y + composer.height} > ${visBottom}`);
    await page.screenshot({ path: `${SHOTS}/m-04-keyboard.png` });

    // keyboard dismissed: height restored, offsetTop must return to 0 (no residual offset)
    await driveVisualViewport(origVvHeight, 0, "resize");
    const down = await readVv();
    if (down.top !== "0px") throw new Error(`--mesh-vvtop did not reset to 0: ${down.top}`);
    const appBack = await boxOf(".app");
    if (Math.abs(appBack.y) > 1) throw new Error(`app left with residual offset after keyboard close: y=${appBack.y}`);
    if (!(await noHScroll())) throw new Error("horizontal overflow after keyboard cycle");
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
